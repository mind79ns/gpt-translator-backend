// translate.js (Netlify function) - AI 문맥 번역 고도화 지원 v6.0
// 주요 수정사항:
// 1. AI 문맥 번역 기능 추가 (useAIContext, contextualPrompt, qualityLevel)
// 2. 전문용어 사전 및 번역 스타일 지원
// 3. 품질 레벨에 따른 모델 선택 및 설정 조정
// 4. 기존 기능 완전 호환성 유지

let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) fetchFn = require('node-fetch');
} catch (e) {
  fetchFn = globalThis.fetch || null;
}

// 🔧 추가: 데이터베이스 연결
const { 
  verifyToken, 
  getUserApiKey, 
  trackUsage, 
  getPublicCache, 
  setPublicCache 
} = require('./database');

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

// 🧠 새로운 AI 문맥 번역 함수
async function translateWithAIContext(inputText, targetLang, contextualPrompt, qualityLevel = 3, getPronunciation = true, userApiKey = null) {
  const apiKey = userApiKey || OPENAI_API_KEY;
  if (!apiKey) throw new Error("서버 오류: API 키가 설정되어 있지 않습니다.");
  if (!inputText || inputText.trim().length === 0) throw new Error("입력 텍스트가 비어있습니다.");
  if (inputText.length > MAX_INPUT_CHARS) throw new Error(`입력 길이 초과 (최대 ${MAX_INPUT_CHARS}자)`);

  // 🔧 공용 캐시 확인 (AI 모드가 아닌 경우만)
  if (!contextualPrompt || contextualPrompt.trim() === '') {
    const publicCache = await getPublicCache(inputText, targetLang);
    if (publicCache.success) {
      return {
        translation: publicCache.data.translation,
        pronunciation_hangul: publicCache.data.pronunciation || ''
      };
    }
  }

  const cacheKey = `ai_tr:${targetLang}:${inputText}:${qualityLevel}:${getPronunciation}:${contextualPrompt.substring(0, 100)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const sourceLanguage = detectSourceLanguage(inputText);

  // 품질 레벨에 따른 모델 및 설정 선택
  const qualityConfig = {
    1: { model: "gpt-4o-mini", temperature: 0.3, maxTokens: 1000 },
    2: { model: "gpt-4o-mini", temperature: 0.1, maxTokens: 1200 },
    3: { model: "gpt-4o", temperature: 0.0, maxTokens: 1500 },
    4: { model: "gpt-4o", temperature: 0.0, maxTokens: 2000 },
    5: { model: "gpt-4o", temperature: 0.0, maxTokens: 2500 }
  };

  const config = qualityConfig[qualityLevel] || qualityConfig[3];

  let systemMessage = `
You are an elite professional translator with deep cultural understanding and linguistic expertise.
ALWAYS return only valid JSON (no extra commentary, no markdown).
The JSON MUST contain exactly two keys: "translation" (string), "pronunciation_hangul" (string).

Core Translation Rules:
- Source language: ${sourceLanguage} → Target language: ${targetLang}
- Preserve named entities, proper nouns, product codes, and URLs exactly as-is
- Maintain appropriate formality level based on context
- Ensure natural, fluent expression in target language`;

  // 품질 레벨에 따른 추가 지침
  if (qualityLevel >= 4) {
    systemMessage += `
- PREMIUM QUALITY: Consider cultural nuances, idiomatic expressions, and regional variations
- Apply advanced linguistic analysis for context-appropriate translations
- Ensure perfect grammar and natural flow`;
  } else if (qualityLevel >= 3) {
    systemMessage += `
- HIGH QUALITY: Focus on accuracy and natural expression
- Consider context and maintain consistency`;
  }

  if (getPronunciation) {
    systemMessage += `
- Provide "pronunciation_hangul" as accurate Korean phonetic transcription of the translated ${targetLang} text
- For Vietnamese: use Korean characters to represent Vietnamese pronunciation (한글 표기)
- For English: use Korean characters to represent English pronunciation`;
  } else {
    systemMessage += `
- Set "pronunciation_hangul" to an empty string`;
  }

  systemMessage += `
- Output format: Return ONLY valid JSON, no other text`;

  // contextualPrompt를 사용자 메시지로 활용
  const userPrompt = contextualPrompt || `Translate this ${sourceLanguage} text to ${targetLang}: """${inputText}"""`;

  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userPrompt }
    ],
    temperature: config.temperature,
    max_tokens: config.maxTokens
  };

  console.log('[AI Translation] 사용 모델:', config.model, '품질 레벨:', qualityLevel);

  const parsed = await retryWithBackoff(async () => {
   const resp = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`AI 번역 API 오류 ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI 번역 응답 없음");

    try {
      return JSON.parse(content);
    } catch (e) {
      // JSON 파싱 실패 시 정리 시도
      const s = content.indexOf('{'), eidx = content.lastIndexOf('}');
      if (s !== -1 && eidx !== -1) {
        const maybe = content.substring(s, eidx + 1);
        return JSON.parse(maybe);
      }
      throw new Error("AI 응답을 JSON으로 파싱하지 못했습니다.");
    }
  }, 3, 300);

  const safe = {
    translation: (parsed.translation || parsed.translated_text || "").toString(),
    pronunciation_hangul: (parsed.pronunciation_hangul || parsed.pronunciation || parsed.pron || "").toString()
  };

  setCache(cacheKey, safe);
  
  // 🔧 공용 캐시에도 저장 (일반 번역인 경우만)
  if (!contextualPrompt || contextualPrompt.trim() === '') {
    await setPublicCache(inputText, targetLang, safe.translation, safe.pronunciation_hangul);
  }
  
  return safe;
}

// 기존 일반 번역 함수 (호환성 유지)
async function translateAndPronounceSingleCall(inputText, targetLang, getPronunciation = true, userApiKey = null) {
  const apiKey = userApiKey || OPENAI_API_KEY;
  if (!apiKey) throw new Error("서버 오류: API 키가 설정되어 있지 않습니다.");
  
  // 🔧 공용 캐시 확인
  const publicCache = await getPublicCache(inputText, targetLang);
  if (publicCache.success) {
    return {
      translation: publicCache.data.translation,
      pronunciation_hangul: publicCache.data.pronunciation || ''
    };
  }
  if (!inputText || inputText.trim().length === 0) throw new Error("입력 텍스트가 비어있습니다.");
  if (inputText.length > MAX_INPUT_CHARS) throw new Error(`입력 길이 초과 (최대 ${MAX_INPUT_CHARS}자)`);

  const cacheKey = `tr:${targetLang}:${inputText}:${getPronunciation}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const sourceLanguage = detectSourceLanguage(inputText);

  let systemMessage = `
You are a professional, consistent translator. ALWAYS return only valid JSON (no extra commentary).
The JSON MUST contain two keys: "translation" (string), "pronunciation_hangul" (string).
Rules:
- Translate the given ${sourceLanguage} text to ${targetLang}.
- Preserve named entities, product codes, and email/URLs as-is.
- Maintain formality: if the input is formal, use formal polite tone; otherwise neutral.
- Keep translation concise and natural.`;

  if (getPronunciation) {
    systemMessage += `
- Provide "pronunciation_hangul" as a Korean-readable transcription of the translated ${targetLang} text (for Vietnamese: 한글 표기).`;
  } else {
    systemMessage += `
- Set "pronunciation_hangul" to an empty string.`;
  }

  systemMessage += `
- Return only JSON (no markdown, no explanation).`;

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
        "Authorization": `Bearer ${apiKey}`,
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
  
  // 🔧 공용 캐시에도 저장
  await setPublicCache(inputText, targetLang, safe.translation, safe.pronunciation_hangul);
  
  return safe;
}

// 문장 분할 헬퍼
function splitIntoSentences(text, maxLength = 200) {
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

// Google Cloud TTS (기존 그대로)
async function getGoogleTTS(text, languageCode = 'vi-VN', voiceName = null, speakingRate = 1.0) {
  console.log('[Google TTS] 시작:', { 
    text: text.substring(0, 50), 
    languageCode, 
    voiceName,
    speakingRate 
  });
  
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      console.error('GOOGLE_SERVICE_ACCOUNT_JSON 환경변수 없음');
      return await getOpenAITTS(text, 'nova');
    }
    
    const { GoogleAuth } = require('google-auth-library');
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    
    if (!accessToken || !accessToken.token) {
      console.error('Google 액세스 토큰 없음');
      return await getOpenAITTS(text, 'nova');
    }

    let selectedVoice = voiceName;
    
    if (!selectedVoice) {
      if (languageCode.startsWith('vi')) {
        selectedVoice = 'vi-VN-Standard-A';
      } else if (languageCode.startsWith('ko')) {
        selectedVoice = 'ko-KR-Standard-A';
      } else {
        selectedVoice = 'en-US-Standard-C';
      }
    }
    
    const voiceLangCode = selectedVoice.substring(0, 5);
    const requestLangCode = languageCode.substring(0, 5);
    
    if (voiceLangCode !== requestLangCode) {
      console.log(`[Google TTS] 언어 코드 불일치 감지: voice=${voiceLangCode}, request=${requestLangCode}`);
      
      if (requestLangCode === 'vi-VN') {
        selectedVoice = voiceName?.includes('-B') || voiceName?.includes('-D') ? 'vi-VN-Standard-B' : 'vi-VN-Standard-A';
      } else if (requestLangCode === 'ko-KR') {
        selectedVoice = voiceName?.includes('-C') || voiceName?.includes('-D') ? 'ko-KR-Standard-C' : 'ko-KR-Standard-A';
      }
    }
    
    console.log('[Google TTS] 최종 선택된 음성:', selectedVoice);
    
    const fetchFunction = fetchFn || require('node-fetch');
    
    const requestBody = {
      input: { text: text },
      voice: { 
        languageCode: languageCode, 
        name: selectedVoice
      },
      audioConfig: { 
        audioEncoding: 'MP3',
        speakingRate: speakingRate || 1.0,
        pitch: 0.0,
        volumeGainDb: 10.0
      }
    };
    
    const response = await fetchFunction(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Google TTS API 오류 ${response.status}:`, errorText);
      return await getOpenAITTS(text, 'nova');
    }

    const data = await response.json();
    
    if (!data.audioContent) {
      console.error('audioContent 없음:', data);
      return await getOpenAITTS(text, 'nova');
    }
    
    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    
    console.log('[Google TTS] 성공:', {
      voice: selectedVoice,
      audioSize: audioBuffer.length,
      isBuffer: Buffer.isBuffer(audioBuffer)
    });
    
    return audioBuffer;
    
  } catch (err) {
    console.error('[Google TTS] 실패:', err.message);
    try {
      console.log('[Google TTS] OpenAI로 폴백 시도');
      return await getOpenAITTS(text, 'nova');
    } catch (fallbackErr) {
      console.error('[Google TTS] 폴백도 실패:', fallbackErr.message);
      throw fallbackErr;
    }
  }
}

// 🔧 개선: OpenAI TTS (API 키 파라미터 강화)
async function getOpenAITTS(text, voice = 'alloy', apiKey = null) {
  const ttsApiKey = apiKey || OPENAI_API_KEY;
  const isUserKey = !!apiKey;
  
  if (!ttsApiKey) {
    throw new Error("서버 오류: API 키가 설정되어 있지 않습니다.");
  }
  
  // 텍스트 길이 제한 (OpenAI TTS 최대 4096자)
  const trimmed = text.length > 4000 ? text.slice(0, 4000) : text;
  
  console.log(`[OpenAI TTS] 요청: ${trimmed.length}자, 음성: ${voice}, 키타입: ${isUserKey ? '사용자' : '시스템'}`);

  const body = {
    model: 'tts-1-hd',
    input: trimmed,
    voice: voice
  };

  const arrBuff = await retryWithBackoff(async () => {
    const resp = await fetchFn("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ttsApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    
    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`[OpenAI TTS] API 오류 ${resp.status}:`, txt);
      
      // 사용자 키일 때 더 구체적인 오류 메시지
      if (isUserKey && resp.status === 401) {
        throw new Error('사용자 API 키가 유효하지 않습니다. 설정을 확인해주세요.');
      } else if (resp.status === 429) {
        throw new Error('API 요청 한도 초과. 잠시 후 다시 시도해주세요.');
      } else {
        throw new Error(`TTS 오류 ${resp.status}: ${txt}`);
      }
    }
    
    return await resp.arrayBuffer();
  }, 3, 400);
  
  const buffer = Buffer.from(arrBuff);
  console.log(`[OpenAI TTS] 성공: ${buffer.length}바이트 생성`);
  
  return buffer;
}

// 🚀 메인 핸들러 - AI 문맥 번역 기능 통합
exports.handler = async function (event, context) {
  const commonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: commonHeaders, body: '' };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...commonHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
   // 🔧 개선: 사용자 인증 처리
const authHeader = event.headers.authorization || event.headers.Authorization;
let userId = null;
let userApiKeys = { openai: null, google: null };

if (authHeader && authHeader.startsWith('Bearer ')) {
  const token = authHeader.substring(7);
  const authResult = await verifyToken(token);
  
  if (authResult.success) {
    userId = authResult.userId;
    console.log(`[Auth] 사용자 인증 성공: ${userId}`);
    
    // 사용자 API 키 병렬 조회로 성능 개선
    const [openaiKeyResult, googleKeyResult] = await Promise.all([
      getUserApiKey(userId, 'openai'),
      getUserApiKey(userId, 'google')
    ]);
    
    userApiKeys = {
      openai: openaiKeyResult.success ? openaiKeyResult.apiKey : null,
      google: googleKeyResult.success ? googleKeyResult.apiKey : null
    };
    
    console.log(`[Auth] API 키 로드 완료 - OpenAI: ${!!userApiKeys.openai}, Google: ${!!userApiKeys.google}`);
  } else {
    console.log(`[Auth] 토큰 검증 실패: ${authResult.error}`);
  }
} else {
  console.log('[Auth] 인증 헤더 없음 - 게스트 모드');
}
    
    const { 
      action, 
      inputText, 
      targetLang, 
      voice, 
      language, 
      chunkIndex, 
      useGoogleTTS, 
      voiceName,
      getPronunciation = true,
      // 🧠 새로운 AI 문맥 번역 파라미터들
      useAIContext = false,
      contextualPrompt = null,
      qualityLevel = 3
    } = JSON.parse(event.body || '{}');

    if (!OPENAI_API_KEY) {
      throw new Error("서버 설정 오류: OPENAI_API_KEY가 없습니다.");
    }

    if (action === 'translate') {
  if (!inputText || !targetLang) {
    return { 
      statusCode: 400, 
      headers: { ...commonHeaders, 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ error: "inputText와 targetLang이 필요합니다." }) 
    };
  }
  
  // 🔧 개선: API 키 선택 로직 강화
  const apiKeyToUse = userApiKeys?.openai || OPENAI_API_KEY;
  const isUserKey = !!userApiKeys?.openai;
  
  if (!apiKeyToUse) {
    return {
      statusCode: 500,
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: "API 키가 설정되지 않았습니다." })
    };
  }
  
  console.log(`[Translation] ${isUserKey ? '사용자' : '시스템'} API 키 사용, 모드: ${useAIContext ? 'AI' : '일반'}`);
  
  let result;
  
  try {
    // 🧠 AI 문맥 번역 vs 일반 번역 분기
    if (useAIContext && contextualPrompt) {
      console.log('[Translation] AI 문맥 번역 모드, 품질 레벨:', qualityLevel);
      result = await translateWithAIContext(
        inputText, 
        targetLang, 
        contextualPrompt, 
        qualityLevel, 
        getPronunciation,
        apiKeyToUse
      );
    } else {
      console.log('[Translation] 일반 번역 모드');
      result = await translateAndPronounceSingleCall(inputText, targetLang, getPronunciation, apiKeyToUse);
    }
    
    // 🔧 개선: 사용량 추적 강화
    if (userId) {
      const cost = inputText.length * 0.000015; // OpenAI 요금 계산
      await trackUsage(userId, 'translation', inputText.length, cost, 'openai');
      console.log(`[Usage] 사용량 추적: ${inputText.length}자, 비용: $${cost.toFixed(6)}`);
    }
    
    // 문장 분할 추가
    const chunks = splitIntoSentences(result.translation);
    result.chunks = chunks;
    
    // AI 모드 표시를 위한 플래그 추가
    if (useAIContext) {
      result.isAITranslation = true;
      result.qualityLevel = qualityLevel;
    }
    
    // 🔧 추가: 응답에 사용된 API 키 정보 포함
    result.usedUserKey = isUserKey;
    
    return {
      statusCode: 200,
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
    
  } catch (error) {
    console.error('[Translation] 번역 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `번역 실패: ${error.message}` })
    };
  }
      
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };

    } else if (action === 'speak') {
  if (!inputText) {
    return { 
      statusCode: 400, 
      headers: { ...commonHeaders, 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ error: "inputText가 필요합니다." }) 
    };
  }
  
  // 🔧 개선: TTS API 키 선택 로직
  const ttsApiKey = userApiKeys?.openai || OPENAI_API_KEY;
  const isUserKey = !!userApiKeys?.openai;
  
  let audioBuffer;
  
  console.log('[Speak] 요청 받음:', { 
    language, 
    voice,
    voiceName,
    useGoogleTTS,
    textLength: inputText.length,
    usingUserKey: isUserKey
  });
  
  try {
    // TTS 엔진 선택 로직
    if (useGoogleTTS === true) {
      console.log('[Speak] Google TTS 선택 (명시적)');
      
      let languageCode = 'vi-VN';
      if (language === 'Korean') {
        languageCode = 'ko-KR';
      } else if (language === 'English') {
        languageCode = 'en-US';
      } else if (language === 'Vietnamese') {
        languageCode = 'vi-VN';
      }
      
      try {
        audioBuffer = await getGoogleTTS(
          inputText, 
          languageCode,
          voiceName || null,
          1.0
        );
        console.log('[Speak] Google TTS 성공');
      } catch (e) {
        console.error('[Speak] Google TTS 실패, OpenAI로 전환:', e.message);
        audioBuffer = await getOpenAITTS(inputText, voice || 'nova', ttsApiKey);
      }
      
    } else if (useGoogleTTS === false) {
      console.log('[Speak] OpenAI TTS 선택 (명시적)');
      
      try {
        audioBuffer = await getOpenAITTS(inputText, voice || 'nova', ttsApiKey);
        console.log('[Speak] OpenAI TTS 성공');
        
        // 🔧 추가: 사용량 추적 (OpenAI TTS 사용 시)
        if (userId) {
          const cost = inputText.length * 0.000015;
          await trackUsage(userId, 'tts', inputText.length, cost, 'openai');
          console.log(`[Usage] TTS 사용량 추적: ${inputText.length}자, 비용: $${cost.toFixed(6)}`);
        }
      } catch (e) {
        console.error('[Speak] OpenAI TTS 실패:', e.message);
        
        let languageCode = 'vi-VN';
        if (language === 'Korean') languageCode = 'ko-KR';
        else if (language === 'English') languageCode = 'en-US';
        
        try {
          audioBuffer = await getGoogleTTS(inputText, languageCode, voiceName, 1.0);
          console.log('[Speak] Google TTS 폴백 성공');
        } catch (fallbackErr) {
          throw new Error('모든 TTS 엔진 실패');
        }
      }
      
    } else {
      console.log('[Speak] TTS 자동 선택 모드');
      
      if (inputText.length < 50) {
        let languageCode = 'vi-VN';
        if (language === 'Korean') languageCode = 'ko-KR';
        else if (language === 'English') languageCode = 'en-US';
        
        audioBuffer = await getGoogleTTS(inputText, languageCode, voiceName, 1.0);
      } else {
        audioBuffer = await getOpenAITTS(inputText, voice || 'nova', ttsApiKey);
        
        // 🔧 추가: 자동 모드에서 OpenAI 사용 시 사용량 추적
        if (userId) {
          const cost = inputText.length * 0.000015;
          await trackUsage(userId, 'tts', inputText.length, cost, 'openai');
          console.log(`[Usage] 자동모드 TTS 사용량 추적: ${inputText.length}자, 비용: $${cost.toFixed(6)}`);
        }
      }
    }
    
    if (!audioBuffer || audioBuffer.length === 0) {
      console.error('[Speak] 오디오 버퍼가 비어있음');
      return {
        statusCode: 500,
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: '오디오 생성 실패 - 빈 버퍼' })
      };
    }
    
    console.log('[Speak] 최종 버퍼 크기:', audioBuffer.length);
    
    return {
      statusCode: 200,
      headers: { ...commonHeaders, 'Content-Type': 'audio/mpeg' },
      isBase64Encoded: true,
      body: audioBuffer.toString('base64'),
    };
    
  } catch (error) {
    console.error('[Speak] TTS 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `TTS 실패: ${error.message}` })
    };
  }
      
    } else if (action === 'speak-chunk') {
      if (!inputText) {
        return { 
          statusCode: 400, 
          headers: { ...commonHeaders, 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ error: "inputText가 필요합니다." }) 
        };
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
      
      if (useGoogleTTS === true) {
        let languageCode = 'vi-VN';
        if (language === 'Korean') languageCode = 'ko-KR';
        else if (language === 'English') languageCode = 'en-US';
        
        try {
          audioBuffer = await getGoogleTTS(
            chunkText, 
            languageCode,
            voiceName || null,
            1.0
          );
        } catch (e) {
          return {
            statusCode: 500,
            headers: { ...commonHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              error: '청크 음성 생성 실패',
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
      return { 
        statusCode: 400, 
        headers: { ...commonHeaders, 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ error: `알 수 없는 action: '${action}'` }) 
      };
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