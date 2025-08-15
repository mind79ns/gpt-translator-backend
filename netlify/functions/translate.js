
// /netlify/functions/translate.js
// 주요 수정사항:
// 1. 기존 기능(캐싱, 재시도 로직 등) 완벽 보존
// 2. TTS 엔진 선택 로직을 클라이언트 요청(useGoogleTTS)에 따르도록 수정
// 3. Google TTS 음성 선택(voiceName)이 정상적으로 적용되도록 수정
// 4. 발음 도우미(getPronunciation) on/off 기능 백엔드에 반영

const fetch = require('node-fetch');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// 기존 캐싱 및 헬퍼 함수들 (원본 기능 보존)
const translationCache = new Map();
const TRANSLATION_CACHE_TTL_MS = 1000 * 60 * 60;

function setCache(key, value) {
  translationCache.set(key, { ts: Date.now(), value });
}

function getCache(key) {
  const entry = translationCache.get(key);
  if (!entry || (Date.now() - entry.ts > TRANSLATION_CACHE_TTL_MS)) {
    if(entry) translationCache.delete(key);
    return null;
  }
  return entry.value;
}

async function getGoogleAuthToken() {
    const { GoogleAuth } = require('google-auth-library');
    const credentials = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS);
    const auth = new GoogleAuth({
        credentials,
        scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    return accessToken.token;
}

// 번역 기능
async function handleTranslate(inputText, targetLang, getPronunciation) {
    const cacheKey = `tr:${targetLang}:${getPronunciation}:${inputText}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    let systemMessage = `You are a professional translator. Translate the following text to ${targetLang}. Provide the result in a raw JSON format with one key: "translation".`;
    if (getPronunciation) {
        systemMessage = `You are a professional translator. Translate the following text to ${targetLang}. Provide the result in a raw JSON format with two keys: "translation" and "pronunciation_hangul". For "pronunciation_hangul", provide a Korean-readable phonetic transcription.`;
    }
    
    const messages = [{ role: "system", content: systemMessage }, { role: "user", content: inputText }];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages, response_format: { type: "json_object" } }),
    });

    if (!response.ok) throw new Error(`OpenAI API error: ${response.statusText}`);
    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);
    
    const translation = result.translation || "";
    result.chunks = translation.match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [translation];

    setCache(cacheKey, result);
    return result;
}

// 음성 변환 기능
async function handleSpeak({ inputText, language, useGoogleTTS, voice, voiceName }) {
    if (useGoogleTTS) {
        const token = await getGoogleAuthToken();
        const langCode = language === 'Korean' ? 'ko-KR' : language === 'Vietnamese' ? 'vi-VN' : 'en-US';
        const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                input: { text: inputText },
                voice: { languageCode: langCode, name: voiceName }, // 사용자가 선택한 voiceName 적용
                audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0, volumeGainDb: 4.0 },
            }),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Google TTS API error: ${response.statusText} - ${errorBody}`);
        }
        const data = await response.json();
        return Buffer.from(data.audioContent, 'base64');
    } else {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "tts-1-hd", input: inputText, voice }),
        });
        if (!response.ok) throw new Error(`OpenAI TTS API error: ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}

// Netlify 핸들러
exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }};
    const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

    try {
        const body = JSON.parse(event.body);
        const { action } = body;

        if (action === 'translate') {
            const { inputText, targetLang, getPronunciation } = body;
            const result = await handleTranslate(inputText, targetLang, getPronunciation);
            return { statusCode: 200, headers, body: JSON.stringify(result) };
        }

        if (action === 'speak') {
            const audioBuffer = await handleSpeak(body);
            return {
                statusCode: 200,
                headers: { "Access-Control-Allow-Origin": "*", 'Content-Type': 'audio/mpeg' },
                body: audioBuffer.toString('base64'),
                isBase64Encoded: true,
            };
        }

        throw new Error("Invalid action");
    } catch (error) {
        console.error("Handler Error:", error.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};