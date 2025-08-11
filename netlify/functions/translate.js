// translate.js (Netlify function) - 통합/최적화 버전
// 특징:
// - 번역 + 한글발음(한글 표기) 단일 호출 (JSON 출력)
// - temperature=0 으로 결정성 보장
// - 간단한 메모리 캐시, 입력 길이 보호, 재시도(Backoff)
// - TTS는 서버에서 생성(폴백). 권장: 브라우저 Web Speech API 사용 (클라이언트에서 처리)

let fetchFn = globalThis.fetch;
try {
  // node runtime에서 global fetch가 없을 경우 node-fetch 사용
  if (!fetchFn) fetchFn = require('node-fetch');
} catch (e) {
  // ignore
  fetchFn = globalThis.fetch || null;
}

const API_KEY = process.env.OPENAI_API_KEY || '';
const MAX_INPUT_CHARS = 6000; // 보호 임계값
const TRANSLATION_CACHE_TTL_MS = 1000 * 60 * 60; // 1시간

const translationCache = new Map();

function setCache(key, value) {
  translationCache.set(key, { ts: Date.now(), value });
}
function getCache(key) {
  const entry = translationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TRANSLATION_CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  return entry.value;
}

function detectSourceLanguage(text) {
  const koreanRegex = /[가-힣]/;
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/i;
  if (koreanRegex.test(text)) return "Korean";
  if (vietnameseRegex.test(text)) return "Vietnamese";
  return "English";
}

async function retryWithBackoff(fn, attempts = 3, baseDelay = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const jitter = Math.random() * 200;
      const delay = baseDelay * Math.pow(2, i) + jitter;
      await new Promise(res => setTimeout(res, delay));
    }
  }
  throw lastErr;
}

// 번역 + 한글발음(한글표기) 단일 호출
async function translateAndPronounceSingleCall(inputText, targetLang) {
  if (!API_KEY) throw new Error("서버 오류: OPENAI_API_KEY가 설정되어 있지 않습니다.");
  if (!inputText || inputText.trim().length === 0) throw new Error("입력 텍스트가 비어있습니다.");
  if (inputText.length > MAX_INPUT_CHARS) throw new Error(`입력 길이 초과 (최대 ${MAX_INPUT_CHARS}자)`);

  const cacheKey = `tr:${targetLang}:${inputText}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const sourceLanguage = detectSourceLanguage(inputText);

  const systemMessage = `
You are a professional, consistent translator. ALWAYS return only valid JSON (no extra commentary).
The JSON MUST contain two keys: "translation" (string), "pronunciation_hangul" (string).
Rules:
- Translate the given ${sourceLanguage} text to ${targetLang}.
- Preserve named entities, product codes, and email/URLs as-is.
- Maintain formality: if the input is formal, use formal polite tone; otherwise neutral.
- Keep translation concise and natural.
- Provide "pronunciation_hangul" as a Korean-readable transcription of the translated ${targetLang} text (for Vietnamese: 한글 표기).
- Return only JSON (no markdown, no explanation).
`;

  const userPrompt = `Text: """${inputText}"""`;

  const payload = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.0,
    max_tokens: 1500
  };

  const parsed = await retryWithBackoff(async () => {
    const resp = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`번역 API 오류 ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("번역 응답 없음");

    // 모델이 JSON 반환을 위반했을 경우 안전 파싱 시도
    try {
      return JSON.parse(content);
    } catch (e) {
      const s = content.indexOf('{'), eidx = content.lastIndexOf('}');
      if (s !== -1 && eidx !== -1) {
        const maybe = content.substring(s, eidx + 1);
        return JSON.parse(maybe);
      }
      throw new Error("응답을 JSON으로 파싱하지 못했습니다.");
    }
  }, 3, 300);

  // 안전 포맷 보장
  const safe = {
    translation: (parsed.translation || parsed.translated_text || "").toString(),
    pronunciation_hangul: (parsed.pronunciation_hangul || parsed.pronunciation || parsed.pron || "").toString()
  };

  setCache(cacheKey, safe);
  return safe;
}

// 서버 TTS (fallback) - Netlify에서 호출시 사용
async function getTTSAudioBuffer(textToSpeak, voice = 'alloy', locale = 'auto') {
  if (!API_KEY) throw new Error("서버 오류: OPENAI_API_KEY가 설정되어 있지 않습니다.");
  const trimmed = textToSpeak.length > 3000 ? textToSpeak.slice(0, 3000) : textToSpeak;

  // 단순 보호: 반복/비속어 제거 등은 클라이언트에서 처리 권장
  const body = {
    model: 'tts-1-hd',
    input: trimmed,
    voice: voice,
    ...(locale && locale !== 'auto' ? { locale } : {})
  };

  const arrBuff = await retryWithBackoff(async () => {
    const resp = await fetchFn("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`TTS 오류 ${resp.status}: ${txt}`);
    }
    return await resp.arrayBuffer();
  }, 3, 400);

  return Buffer.from(arrBuff);
}

// Netlify handler
exports.handler = async function (event, context) {
  const commonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: commonHeaders, body: '' };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const { action, inputText, targetLang, voice, language } = JSON.parse(event.body || '{}');

    if (!API_KEY) {
      throw new Error("서버 설정 오류: OPENAI_API_KEY가 없습니다.");
    }

    if (action === 'translate') {
      if (!inputText || !targetLang) {
        return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "inputText와 targetLang가 필요합니다." }) };
      }
      const result = await translateAndPronounceSingleCall(inputText, targetLang);
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };

    } else if (action === 'speak') {
      if (!inputText || !voice) {
        return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "inputText와 voice가 필요합니다." }) };
      }
      const audioBuffer = await getTTSAudioBuffer(inputText, voice, language || 'auto');
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'audio/mpeg' },
        isBase64Encoded: true,
        body: audioBuffer.toString('base64'),
      };
    } else {
      return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `알 수 없는 action: '${action}'` }) };
    }
  } catch (err) {
    console.error("핸들러 오류 발생:", err);
    return {
      statusCode: 500,
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || '서버 오류' }),
    };
  }
};
