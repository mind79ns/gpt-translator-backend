const API_KEY = process.env.OPENAI_API_KEY;

// ✅ GPT 번역 및 발음 요청 - 자연스러운 번역을 위한 고급 프롬프트
async function getTranslationAndPronunciation(inputText, targetLang) {
  console.log(`번역 요청: "${inputText}" -> ${targetLang}`);
  
  // 🌟 언어별 소스 언어 자동 감지 및 설정
  const sourceLanguage = detectSourceLanguage(inputText);
  
  // 🌟 개선된 프롬프트 - 자연스럽고 상황에 맞는 번역
  const prompt = `
You are a professional translator with expertise in natural, culturally appropriate translations between Korean, Vietnamese, and English.

SOURCE LANGUAGE: ${sourceLanguage}
TARGET LANGUAGE: ${targetLang}
TEXT TO TRANSLATE: "${inputText}"

TRANSLATION REQUIREMENTS:
1. Use natural, conversational tone (avoid robotic/literal translations)
2. Apply appropriate formality level based on context
3. Use culturally appropriate expressions and idioms when suitable
4. Consider the speaker's likely intent and emotion
5. For Vietnamese: Use proper honorifics (anh/chị/em) when addressing people
6. For Korean: Apply appropriate speech levels (존댓말/반말)
7. For English: Use natural, flowing expressions

ADDITIONAL CONTEXT:
- If the text seems like a question to a service provider (taxi, restaurant, etc.), use polite customer language
- If it's a business context, use professional tone
- If it's casual conversation, use friendly, natural expressions
- Preserve any emotional tone (excitement, concern, politeness, etc.)

Please provide your response in JSON format with two fields:
{
  "translation": "Your natural, contextually appropriate translation here",
  "pronunciation": "Korean-style pronunciation in Hangul (한글 발음 표기)"
}

EXAMPLES OF NATURAL TRANSLATION STYLE:
- Korean "안녕하세요" → Vietnamese "Xin chào ạ" (polite greeting)
- Korean "고마워" → Vietnamese "Cảm ơn" (casual thanks)
- Vietnamese "Xin lỗi anh" → Korean "죄송합니다" (polite apology)
- English "How much?" → Vietnamese "Bao nhiêu tiền ạ?" (polite inquiry)
`;

  const options = {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      response_format: { "type": "json_object" },
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3, // 약간 높여서 더 자연스러운 표현 유도
      max_tokens: 500   // 토큰 제한 추가
    })
  };

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", options);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`번역 API 오류: ${response.status} - ${errorText}`);
      throw new Error(`번역 API 오류: ${response.status}`);
    }

    const data = await response.json();
    console.log('번역 API 응답:', JSON.stringify(data));

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('번역 API 응답 형식이 올바르지 않습니다.');
    }

    // JSON 파싱 시도
    let result;
    try {
      result = JSON.parse(data.choices[0].message.content);
    } catch (parseError) {
      console.error('JSON 파싱 오류:', parseError);
      console.error('원본 응답:', data.choices[0].message.content);
      // JSON 파싱 실패 시 대안 처리
      const content = data.choices[0].message.content;
      return {
        translation: content.trim(),
        pronunciation: "발음 정보 없음"
      };
    }

    return {
      translation: result.translation?.trim() || "번역 결과 없음",
      pronunciation: result.pronunciation?.trim() || "발음 정보 없음"
    };
  } catch (error) {
    console.error('번역 요청 오류:', error);
    throw error;
  }
}

// 🌟 소스 언어 자동 감지 함수 (개선된 버전)
function detectSourceLanguage(text) {
  const koreanRegex = /[가-힣]/g;
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/g;
  const englishRegex = /[a-zA-Z]/g;
  
  const koreanCount = (text.match(koreanRegex) || []).length;
  const vietnameseCount = (text.match(vietnameseRegex) || []).length;
  const englishCount = (text.match(englishRegex) || []).length;
  
  // 가장 많이 포함된 문자 기준으로 언어 결정
  if (koreanCount > vietnameseCount && koreanCount > englishCount) {
    return "Korean";
  } else if (vietnameseCount > koreanCount && vietnameseCount > englishCount) {
    return "Vietnamese";  
  } else {
    return "English";
  }
}

// ✅ OpenAI 음성 합성(TTS) API 호출 (기존과 동일)
async function getTTSAudio(text, voice) {
  console.log(`TTS 요청: "${text}" (음성: ${voice})`);
  
  const options = {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: voice,
      response_format: 'mp3',
    })
  };

  const timeout = 30000;
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('TTS API 호출 타임아웃 (30초)')), timeout)
  );

  try {
    console.log('TTS API 호출 시작...');
    const response = await Promise.race([
      fetch("https://api.openai.com/v1/audio/speech", options), 
      timeoutPromise
    ]);

    console.log(`TTS API 응답 상태: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`TTS API 오류: ${response.status} - ${errorText}`);
      throw new Error(`TTS API 오류: ${response.status} - ${errorText}`);
    }

    console.log('TTS API 성공, 오디오 데이터 변환 중...');
    return response;
    
  } catch (error) {
    console.error(`TTS API 호출 실패:`, error);
    throw new Error(`TTS API 호출 실패: ${error.message}`);
  }
}

// ✅ Netlify Functions의 요청 핸들러 (기존과 동일)
exports.handler = async (event, context) => {
  console.log('=== Functions 핸들러 시작 ===');
  console.log('HTTP Method:', event.httpMethod);
  console.log('Request Body:', event.body);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    console.log('OPTIONS 요청 처리');
    return { 
      statusCode: 200, 
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      }, 
      body: 'OK' 
    };
  }

  if (event.httpMethod !== 'POST') {
    console.log('잘못된 HTTP 메서드:', event.httpMethod);
    return { 
      statusCode: 405, 
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      }, 
      body: JSON.stringify({ error: "Method not allowed" }) 
    };
  }

  if (!API_KEY) {
    console.error('OPENAI_API_KEY가 설정되지 않음');
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: "서버 설정 오류: API 키 없음" }),
    };
  }

  try {
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (parseError) {
      console.error('요청 본문 파싱 오류:', parseError);
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: "잘못된 JSON 형식" }),
      };
    }

    const { action, inputText, targetLang, voice } = requestBody;
    console.log(`요청 액션: ${action}`);

    if (action === 'translate') {
      console.log('번역 요청 처리 중...');
      const { translation, pronunciation } = await getTranslationAndPronunciation(inputText, targetLang);
      
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ translation, pronunciation }),
      };
      
    } else if (action === 'speak' && voice) {
      console.log('TTS 요청 처리 중...');
      
      if (!inputText || inputText.trim() === '') {
        return {
          statusCode: 400,
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ error: "음성 변환할 텍스트가 없습니다." }),
        };
      }

      const audioResponse = await getTTSAudio(inputText, voice);
      const audioBuffer = await audioResponse.arrayBuffer();
      
      console.log(`오디오 데이터 크기: ${audioBuffer.byteLength} bytes`);
      
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.byteLength.toString(),
        },
        isBase64Encoded: true,
        body: Buffer.from(audioBuffer).toString('base64'),
      };
      
    } else {
      console.log('잘못된 요청:', { action, hasVoice: !!voice });
      return { 
        statusCode: 400, 
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        }, 
        body: JSON.stringify({ error: "올바르지 않은 요청입니다." }) 
      };
    }
    
  } catch (err) {
    console.error("Handler Error:", err);
    console.error("Error Stack:", err.stack);
    
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        error: "서버 내부 오류", 
        details: err.message 
      }),
    };
  }
};