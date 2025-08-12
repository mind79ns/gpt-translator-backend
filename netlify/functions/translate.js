// translate.js (Netlify function) - Fixed Google TTS Issues
// 주요 수정사항:
// 1. fetch 문제 해결
// 2. base64 디코딩 추가
// 3. 음성 일관성 보장
// 4. 에러 로깅 강화

let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) fetchFn = require('node-fetch');
} catch (e) {
  fetchFn = globalThis.fetch || null;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || '';
const MAX_INPUT_CHARS = 6000;
const TRANSLATION_CACHE_TTL_MS = 1000 * 60 * 60;

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

// 번역 + 한글발음 단일 호출
async function translateAndPronounceSingleCall(inputText, targetLang) {
  if (!OPENAI_API_KEY) throw new Error("서버 오류: OPENAI_API_KEY가 설정되어 있지 않습니다.");
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
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
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

  const safe = {
    translation: (parsed.translation || parsed.translated_text || "").toString(),
    pronunciation_hangul: (parsed.pronunciation_hangul || parsed.pronunciation || parsed.pron || "").toString()
  };

  setCache(cacheKey, safe);
  return safe;
}

// 문장 분할 헬퍼
function splitIntoSentences(text, maxLength = 200) {
  // 문장 부호로 먼저 분할
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  
  let currentChunk = '';
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= maxLength) {
      currentChunk += sentence;
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  
  return chunks;
}

// 🔥 수정된 Google Cloud TTS - 모든 문제 해결
async function getGoogleTTS(text, languageCode = 'vi-VN', voiceName = null, speakingRate = 1.0) {
  console.log('[Google TTS] 시작:', { text: text.substring(0, 50), languageCode, voiceName });
  
  try {
    // 서비스 계정 확인
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 환경변수 미설정');
    }
    
    const { GoogleAuth } = require('google-auth-library');
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    
    if (!accessToken.token) {
      throw new Error('Google 액세스 토큰 획득 실패');
    }

    // 베트남어 음성 옵션 개선
    const vietnameseVoices = [
      'vi-VN-Neural2-A',  // 여성, 최고 품질
      'vi-VN-Neural2-D',  // 남성, 최고 품질
      'vi-VN-Wavenet-A',  // 여성, 고품질
      'vi-VN-Wavenet-B',  // 남성, 고품질
    ];
    
    // 음성 선택 (voiceName이 없으면 랜덤하게 최고품질 선택)
    const selectedVoice = voiceName || vietnameseVoices[0];
    
    // ✅ fetch 함수 사용 (node-fetch 또는 globalThis.fetch)
    const fetchFunction = fetchFn || require('node-fetch');
    
    const response = await fetchFunction(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: { text },
          voice: { 
            languageCode, 
            name: selectedVoice 
          },
          audioConfig: { 
            audioEncoding: 'MP3',
            speakingRate: speakingRate,
            pitch: 0,
            volumeGainDb: 0  // 볼륨 정상화
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google TTS API 오류 ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.audioContent) {
      throw new Error('Google TTS 응답에 audioContent 없음');
    }
    
    // ✅ 중요: base64를 Buffer로 변환
    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    
    console.log('[Google TTS] 성공:', {
      voice: selectedVoice,
      audioSize: audioBuffer.length
    });
    
    return audioBuffer;
    
  } catch (err) {
    console.error('[Google TTS] 실패 상세:', err.message);
    throw err;  // ❌ OpenAI로 폴백하지 않고 에러 전파
  }
}

// OpenAI TTS (기존)
async function getOpenAITTS(text, voice = 'alloy') {
  if (!OPENAI_API_KEY) throw new Error("서버 오류: OPENAI_API_KEY가 설정되어 있지 않습니다.");
  
  const trimmed = text.length > 3000 ? text.slice(0, 3000) : text;

  const body = {
    model: 'tts-1-hd',
    input: trimmed,
    voice: voice
  };

  const arrBuff = await retryWithBackoff(async () => {
    const resp = await fetchFn("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
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

// Netlify handler - 개선된 버전
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
    const { action, inputText, targetLang, voice, language, chunkIndex, useGoogleTTS, voiceName } = JSON.parse(event.body || '{}');

    if (!OPENAI_API_KEY) {
      throw new Error("서버 설정 오류: OPENAI_API_KEY가 없습니다.");
    }

    if (action === 'translate') {
      if (!inputText || !targetLang) {
        return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "inputText와 targetLang가 필요합니다." }) };
      }
      const result = await translateAndPronounceSingleCall(inputText, targetLang);
      
      // 문장 분할 추가
      const chunks = splitIntoSentences(result.translation);
      result.chunks = chunks;
      
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };

    } else if (action === 'speak') {
      if (!inputText || (!voice && !useGoogleTTS)) {
        return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "inputText와 voice가 필요합니다." }) };
      }
      
      let audioBuffer;
      
      // ✅ 베트남어는 무조건 Google TTS만 사용 (일관성 보장)
      if (language === 'Vietnamese') {
        try {
          console.log('[Speak] 베트남어 Google TTS 사용');
          audioBuffer = await getGoogleTTS(
            inputText, 
            'vi-VN',
            voiceName || 'vi-VN-Neural2-A',  // 기본값: 최고품질 여성 음성
            1.0
          );
        } catch (e) {
          // Google TTS 실패시 에러 반환 (OpenAI 폴백 제거)
          console.error('[Speak] Google TTS 실패:', e.message);
          return {
            statusCode: 500,
            headers: { ...commonHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              error: '베트남어 음성 생성 실패. Google TTS 설정을 확인하세요.',
              details: e.message 
            })
          };
        }
      } else {
        // 한국어/영어는 OpenAI TTS
        audioBuffer = await getOpenAITTS(inputText, voice || 'alloy');
      }
      
      // audioBuffer가 Buffer인지 확인
      if (!Buffer.isBuffer(audioBuffer)) {
        console.error('audioBuffer is not a Buffer:', typeof audioBuffer);
        throw new Error('오디오 버퍼 생성 실패');
      }
      
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'audio/mpeg' },
        isBase64Encoded: true,
        body: audioBuffer.toString('base64'),
      };
      
    } else if (action === 'speak-chunk') {
      // 청크 단위 TTS (스트리밍용)
      if (!inputText) {
        return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "inputText가 필요합니다." }) };
      }
      
      const chunks = splitIntoSentences(inputText);
      const idx = parseInt(chunkIndex || 0);
      
      if (idx >= chunks.length) {
        return { 
          statusCode: 200, 
          headers: { ...commonHeaders, 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ completed: true, totalChunks: chunks.length }) 
        };
      }
      
      const chunkText = chunks[idx];
      let audioBuffer;
      
      // ✅ 베트남어 일관성 보장
      if (language === 'Vietnamese') {
        try {
          audioBuffer = await getGoogleTTS(
            chunkText, 
            'vi-VN',
            voiceName || 'vi-VN-Neural2-A',
            1.0
          );
        } catch (e) {
          return {
            statusCode: 500,
            headers: { ...commonHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              error: '베트남어 청크 음성 생성 실패',
              details: e.message 
            })
          };
        }
      } else {
        audioBuffer = await getOpenAITTS(chunkText, voice || 'alloy');
      }
      
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: audioBuffer.toString('base64'),
          chunkIndex: idx,
          totalChunks: chunks.length,
          text: chunkText,
          completed: false
        }),
      };
      
    } else {
      return { statusCode: 400, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `알 수 없는 action: '${action}'` }) };
    }
  } catch (err) {
    console.error("핸들러 오류 발생:", err);
    return {
      statusCode: 500,
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: err.message || '서버 오류',
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }),
    };
  }
};