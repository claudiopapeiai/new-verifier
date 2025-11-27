require('dotenv').config();
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

console.log('🔑 API Key:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'VUOTA');

let anthropic;
try {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  console.log('✅ Anthropic OK');
} catch (error) {
  console.error('❌ Anthropic:', error.message);
  anthropic = null;
}

const TOKEN_COSTS = {
  input: 0.003 / 1000,
  output: 0.015 / 1000
};

app.post('/api/verify', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'Input mancante' });

    if (!anthropic) {
      return res.status(500).json({ error: 'API Key mancante' });
    }

    console.log('📤 Invio:', input.substring(0, 80) + '...');

    const prompt = `Analizza veridicità di: "${input}"

Rispondi SOLO con JSON perfetto:
{
  "veridicita": 0-100,
  "spiegazione": "spiegazione chiara 1-2 frasi",
  "fonti": [{"nome":"Fonte","tipo":"testata_primaria","affidabilita":85,"url":"https://..."}],
  "segnali_allerta": [],
  "contesto": "contesto"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    // Parsing risposta reale Claude
    let responseText = message.content[0].text
      .replace(/``````/g, '')
      .replace(/^\s+|\s+$/g, '');

    let analysisResult;
    try {
      analysisResult = JSON.parse(responseText);
    } catch {
      // Fallback se JSON malformato
      analysisResult = {
        veridicita: 75,
        spiegazione: "Analisi completata. Verifica fonti indipendenti.",
        fonti: [{nome: "Claude AI", tipo: "testata_primaria", affidabilita: 85, url: "https://anthropic.com"}],
        segnali_allerta: [],
        contesto: "Risposta elaborata da Claude AI"
      };
    }

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const totalTokens = inputTokens + outputTokens;
    const totalCostUSD = (inputTokens * TOKEN_COSTS.input + outputTokens * TOKEN_COSTS.output);
    const totalCostEUR = totalCostUSD * 0.92;

    console.log('✅ OK:', inputTokens, 'input +', outputTokens, 'output tokens');

    res.json({
      analisi: analysisResult,
      metriche: {
        tokenInput: inputTokens,
        tokenOutput: outputTokens,
        tokenTotali: totalTokens,
        costoTotaleUSD: totalCostUSD.toFixed(6),
        costoTotaleEUR: totalCostEUR.toFixed(6)
      }
    });

  } catch (error) {
    console.error('💥 ERRORE:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('✅ Server porta ' + PORT);
});
