const fetch = require('node-fetch');

const API_KEY = process.env.OPENAI_API_KEY;

// --- 헬퍼 함수: 기능별로 역할을 명확히 분리 ---

/**
 * 텍스트의 소스 언어(한/영/베)를 자동으로 감지합니다.
 * @param {string} text - 감지할 텍스트
 * @returns {string} "Korean", "Vietnamese", 또는 "English"
 */
function detectSourceLanguage(text) {
  const koreanRegex = /[가-힣]/;
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  
  if (koreanRegex.test(text)) return "Korean";
  if (vietnameseRegex.test(text)) return "Vietnamese";
  return "English";
}

/**
 * [기능 1] 번역 및 발음 요청 (API 호출 1회로 최적화)
 * @param {string} inputText - 번역할 텍스트
 * @param {string} targetLang - 목표 언어
 * @returns {Promise<{translation: string, pronunciation: string}>} 번역 및 발음 객체
 */
async function getTranslationAndPronunciation(inputText, targetLang) {
  const sourceLanguage = detectSourceLanguage(inputText);
  
  // 사용자님이 작성하신 고품질 프롬프트를 사용하여 API 호출을 1회로 최적화
  const prompt = `
You are a professional translator specializing in natural translations between Korean, Vietnamese, and English.
SOURCE LANGUAGE: ${sourceLanguage}
TARGET LANGUAGE: ${targetLang}
TEXT TO TRANSLATE: "${inputText}"

Provide your response in a JSON object with two keys: "translation" and "pronunciation" (Korean-style pronunciation in Hangul).
Example: { "translation": "Your translation here", "pronunciation": "발음 표기" }
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      response_format: { "type": "json_object" },
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`번역 API 오류: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const result = JSON.parse(data.choices[0].message.content);

  return {
    translation: result.translation?.trim() || "번역 결과 없음",
    pronunciation: result.pronunciation?.trim() || "발음 정보 없음"
  };
}

/**
 * [기능 2] TTS(음성 합성) 요청
 * @param {string} textToSpeak - 음성으로 변환할 텍스트
 * @param {string} voice - 사용할 음성 (e.g., "alloy")
 * @returns {Promise<Buffer>} 오디오 데이터 버퍼
 */
async function getTTSAudio(textToSpeak, voice) {
  const ttsResponse = await fetch("https://api.openai.com/v1/audio/speech", {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1-hd", // 고품질 음성 모델
      input: textToSpeak,
      voice: voice,
      response_format: 'mp3'
    })
  });

  if (!ttsResponse.ok) {
    const errorText = await ttsResponse.text();
    throw new Error(`TTS API 오류: ${ttsResponse.status} - ${errorText}`);
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
  return Buffer.from(audioBuffer);
}


// --- 메인 핸들러: 요청을 받아 각 기능에 연결하는 역할만 담당 ---

/**
 * Netlify Functions 메인 핸들러
 */
exports.handler = async function(event, context) {
  // CORS 및 공통 헤더
  const commonHeaders = {
    'Access-Control-Allow-Origin': '*', // 실제 프로덕션에서는 특정 도메인으로 제한하는 것이 안전합니다.
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // CORS Pre-flight 요청 처리
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: commonHeaders, body: '' };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: {...commonHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const { action, inputText, targetLang, voice } = JSON.parse(event.body || '{}');

    if (!API_KEY) {
      throw new Error("서버 설정 오류: OPENAI_API_KEY가 없습니다.");
    }

    // action 값에 따라 적절한 함수 호출
    if (action === 'translate') {
      if (!inputText || !targetLang) {
        return { statusCode: 400, headers: {...commonHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({ error: "inputText와 targetLang가 필요합니다." }) };
      }
      const result = await getTranslationAndPronunciation(inputText, targetLang);
      return {
        statusCode: 200,
        headers: {...commonHeaders, 'Content-Type': 'application/json'},
        body: JSON.stringify(result),
      };

    } else if (action === 'speak') {
      if (!inputText || !voice) {
        return { statusCode: 400, headers: {...commonHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({ error: "inputText와 voice가 필요합니다." }) };
      }
      const audioBuffer = await getTTSAudio(inputText, voice);
      
      // 오디오 데이터를 직접 반환 (프론트엔드에서 처리하기 가장 좋은 방식)
      return {
        statusCode: 200,
        headers: { ...commonHeaders, 'Content-Type': 'audio/mpeg' },
        isBase64Encoded: true,
        body: audioBuffer.toString('base64'),
      };

    } else {
      return { statusCode: 400, headers: {...commonHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({ error: `알 수 없는 action: '${action}'` }) };
    }

  } catch (err) {
    console.error("핸들러 오류 발생:", err);
    return {
      statusCode: 500,
      headers: {...commonHeaders, 'Content-Type': 'application/json'},
      body: JSON.stringify({ error: err.message }),
    };
  }
};