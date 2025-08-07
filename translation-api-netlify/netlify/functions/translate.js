const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const { inputText, targetLang } = JSON.parse(event.body);
  const API_KEY = process.env.OPENAI_API_KEY;

  if (!inputText || !targetLang) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "inputText 또는 targetLang이 없습니다." }),
    };
  }

  try {
    const prompt = `Translate the following sentence into ${targetLang}. Only return the translated sentence. No explanation.\n\n"${inputText}"`;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const data = await response.json();
    const translation = data.choices[0].message.content.trim();

    const pronPrompt = `Write the Korean-style pronunciation (Hangul only) of the following ${targetLang} sentence:\n"${translation}"\n\nJust output the Hangul only.`;
    const pronResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: pronPrompt }],
        temperature: 0.2
      })
    });

    const pronData = await pronResponse.json();
    const pronunciation = pronData.choices[0].message.content.trim();

    return {
      statusCode: 200,
      body: JSON.stringify({ translation, pronunciation }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};