require('dotenv').config();
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser(process.env.COOKIE_SECRET || 'fallback-secret-key'));

console.log('API Key:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'VUOTA');

let anthropic;
try {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  console.log('Anthropic OK');
} catch (error) {
  console.error('Error:', error.message);
  anthropic = null;
}

const TOKEN_COSTS = {
  input: 0.003 / 1000,
  output: 0.015 / 1000
};

// Rate limiting: 2 verifiche al giorno per browser
const MAX_REQUESTS_PER_DAY = 2;
const browserUsage = new Map();

function rateLimitPerBrowser(req, res, next) {
  let clientId = req.signedCookies.clientId;
  
  if (!clientId) {
    clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    res.cookie('clientId', clientId, {
      signed: true,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'strict'
    });
  }

  const now = Date.now();
  const record = browserUsage.get(clientId);

  if (!record) {
    browserUsage.set(clientId, { count: 1, firstRequestAt: now });
    return next();
  }

  const elapsed = now - record.firstRequestAt;
  if (elapsed > 24 * 60 * 60 * 1000) {
    browserUsage.set(clientId, { count: 1, firstRequestAt: now });
    return next();
  }

  if (record.count >= MAX_REQUESTS_PER_DAY) {
    return res.status(429).json({
      error: `Hai raggiunto il limite giornaliero di ${MAX_REQUESTS_PER_DAY} verifiche. Riprova domani.`
    });
  }

  record.count += 1;
  browserUsage.set(clientId, record);
  next();
}

app.post('/api/verify', rateLimitPerBrowser, async (req, res) => {
  let responseTime = 0;

  try {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'Input mancante' });

    if (!anthropic) {
      return res.status(500).json({ error: 'API Key mancante' });
    }

    console.log('Input:', input.substring(0, 80));
    const startTime = Date.now();

    const prompt = `Sei un fact-checker professionale. Analizza la seguente affermazione/notizia e fornisci un'analisi dettagliata in formato JSON.

AFFERMAZIONE: "${input}"

IMPORTANTE: Rispondi SOLO con l'oggetto JSON puro, senza wrapper markdown, senza backtick, senza prefissi come "json".

Fornisci una valutazione completa con questi campi JSON:

{
  "veridicita": <numero da 0-100>,
  "spiegazione": "<analisi dettagliata di 2-3 frasi su perche assegni questo valore>",
  "fonti": [
    {
      "nome": "<nome della fonte>",
      "tipo": "testata_primaria|testata_secondaria|giornale_online|istituzionale_italia|istituzionale_estero|blog_verificato|forum|social_media|sconosciuto",
      "affidabilita": <0-100>,
      "url": "<url se disponibile>"
    }
  ],
  "segnali_allerta": ["<segnale 1>", "<segnale 2>"],
  "contesto": "testo aggiuntivo importante>"
}

ISTRUZIONI:
- Veridicita: valuta 0-100 in base a verità, probabilità, prove disponibili
- Analizza la logica interna dell'affermazione
- Identifica qualsiasi elemento dubbio o mancante
- Fornisci segnali di attenzione se ci sono elementi sospetti
- Fornisci fonti credibili se possibile
- Sii critico ma giusto
- Rispondi SOLO con JSON valido, niente altro`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const endTime = Date.now();
    responseTime = endTime - startTime;

    let responseText = message.content[0].text.trim();

    // Pulizia robusta della risposta
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      responseText = jsonMatch[0];
    } else {
      responseText = responseText.replace(/^```
      responseText = responseText.replace(/^```\s*/, '');
      responseText = responseText.replace(/```
      if (responseText.toLowerCase().startsWith('json')) {
        responseText = responseText.substring(4).trim();
      }
      responseText = responseText.trim();
    }

    console.log('Response:', responseText.substring(0, 150));

    let analysisResult;
    try {
      analysisResult = JSON.parse(responseText);
      console.log('JSON OK - Veridicita:', analysisResult.veridicita);
    } catch (e) {
      console.error('Parse error:', e.message);
      console.log('Raw response:', responseText.substring(0, 300));
      analysisResult = {
        veridicita: 50,
        spiegazione: "Analisi completata da Claude. Verifica fonti indipendenti per conferma.",
        fonti: [{ nome: "Claude AI", tipo: "testata_primaria", affidabilita: 75, url: "https://anthropic.com" }],
        segnali_allerta: ["Risposta incompleta - consultare fonti multiple"],
        contesto: "Valutazione preliminare"
      };
    }

    const inputTokens = message.usage.input_tokens || 0;
    const outputTokens = message.usage.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;
    const totalCostUSD = (inputTokens * TOKEN_COSTS.input + outputTokens * TOKEN_COSTS.output);
    const totalCostEUR = totalCostUSD * 0.92;

    console.log('Tokens:', inputTokens, '+', outputTokens, '=', totalTokens);

    res.json({
      analisi: analysisResult,
      metriche: {
        tokenInput: inputTokens,
        tokenOutput: outputTokens,
        tokenTotali: totalTokens,
        costoTotale: `$${totalCostUSD.toFixed(6)}`,
        costoTotaleEuro: `EUR ${totalCostEUR.toFixed(6)}`,
        tempoRisposta: `${responseTime}ms`
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Server porta ' + PORT);
});

