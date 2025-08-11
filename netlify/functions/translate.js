const fetch = require('node-fetch');

const API_KEY = process.env.OPENAI_API_KEY;

function detectSourceLanguage(text) {
  const koreanRegex = /[가-힣]/;
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  
  if (koreanRegex.test(text)) return "Korean";
  if (vietnameseRegex.test(text)) return "Vietnamese";
  return "English";
}

async function getTranslationAndPronunciation(inputText, targetLang) {
  const sourceLanguage = detectSourceLanguage(inputText);
  
  // Step 1: 먼저 번역만 수행
  const translatePrompt = `Translate this ${sourceLanguage} text to ${targetLang}: "${inputText}"
Return ONLY the translation, nothing else.`;

  const translateResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: translatePrompt }],
      temperature: 0.1
    })
  });

  if (!translateResponse.ok) {
    throw new Error(`번역 API 오류`);
  }

  const translateData = await translateResponse.json();
  const translation = translateData.choices[0].message.content.trim();

  // Step 2: 번역된 텍스트의 한글 발음 생성
  let pronunciation = "";
  
  if (targetLang === "Korean") {
    pronunciation = translation;
  } else {
    const pronPrompt = `Write the Korean pronunciation (한글 표기) for this ${targetLang} text: "${translation}"
Examples:
- "Xin chào" → "씬 짜오"
- "Hello" → "헬로"
- "Thank you" → "땡큐"
Return ONLY the Korean pronunciation, nothing else.`;

    const pronResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: pronPrompt }],
        temperature: 0.1
      })
    });

    if (pronResponse.ok) {
      const pronData = await pronResponse.json();
      pronunciation = pronData.choices[0].message.content.trim();
    }
  }

  return {
    translation: translation,
    pronunciation: pronunciation || "발음 정보 없음"
  };
}

async function getTTSAudio(textToSpeak, voice, language) {
  // 베트남어 감지
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/;
  const isVietnamese = language === 'Vietnamese' || vietnameseRegex.test(textToSpeak);
  
  let processedText = textToSpeak;
  let selectedVoice = voice;  // 사용자 선택 음성 유지
  let selectedModel = "tts-1-hd";
  let speed = 1.0;
  
if (isVietnamese) {
    console.log("베트남어 TTS 처리 - 선택된 음성:", voice);
    
    // 베트남어 텍스트를 영어식 발음으로 변환 (안정성 향상) - 이 부분 추가!
    const vietnameseMap = {
      'ă': 'a', 'â': 'a', 'đ': 'd', 'ê': 'e', 'ô': 'o', 'ơ': 'o', 'ư': 'u',
      'Ă': 'A', 'Â': 'A', 'Đ': 'D', 'Ê': 'E', 'Ô': 'O', 'Ơ': 'O', 'Ư': 'U',
      'à': 'a', 'á': 'a', 'ạ': 'a', 'ả': 'a', 'ã': 'a',
      'ầ': 'a', 'ấ': 'a', 'ậ': 'a', 'ẩ': 'a', 'ẫ': 'a',
      'ằ': 'a', 'ắ': 'a', 'ặ': 'a', 'ẳ': 'a', 'ẵ': 'a',
      'è': 'e', 'é': 'e', 'ẹ': 'e', 'ẻ': 'e', 'ẽ': 'e',
      'ề': 'e', 'ế': 'e', 'ệ': 'e', 'ể': 'e', 'ễ': 'e',
      'ì': 'i', 'í': 'i', 'ị': 'i', 'ỉ': 'i', 'ĩ': 'i',
      'ò': 'o', 'ó': 'o', 'ọ': 'o', 'ỏ': 'o', 'õ': 'o',
      'ồ': 'o', 'ố': 'o', 'ộ': 'o', 'ổ': 'o', 'ỗ': 'o',
      'ờ': 'o', 'ớ': 'o', 'ợ': 'o', 'ở': 'o', 'ỡ': 'o',
      'ù': 'u', 'ú': 'u', 'ụ': 'u', 'ủ': 'u', 'ũ': 'u',
      'ừ': 'u', 'ứ': 'u', 'ự': 'u', 'ử': 'u', 'ữ': 'u',
      'ỳ': 'y', 'ý': 'y', 'ỵ': 'y', 'ỷ': 'y', 'ỹ': 'y'
    };
    
    // 베트남어 문자를 영어식으로 변환
    for (const [viet, eng] of Object.entries(vietnameseMap)) {
      processedText = processedText.replace(new RegExp(viet, 'g'), eng);
    }
    
    // 음성별 최적화 설정
    const voiceSettings = {
      'nova': { model: 'tts-1', speed: 0.9 },      
      'shimmer': { model: 'tts-1', speed: 0.9 },   
      'alloy': { model: 'tts-1', speed: 0.95 },    
      'echo': { model: 'tts-1-hd', speed: 0.9 },   
      'fable': { model: 'tts-1', speed: 0.95 },    
      'onyx': { model: 'tts-1', speed: 0.85 }      
    };
    
    // 베트남어 문자 최소 변환 (안정성을 위해 đ만 변환)
    processedText = processedText.replace(/đ/g, 'd').replace(/Đ/g, 'D');
    
    // 음성별 최적화 설정
    const voiceSettings = {
      'nova': { model: 'tts-1', speed: 0.9 },      // 여성, 가장 안정적
      'shimmer': { model: 'tts-1', speed: 0.9 },   // 여성, 부드러움
      'alloy': { model: 'tts-1', speed: 0.95 },    // 남성, 차분함
      'echo': { model: 'tts-1-hd', speed: 0.9 },   // 남성, HD
      'fable': { model: 'tts-1', speed: 0.95 },    // 남성, 표현력
      'onyx': { model: 'tts-1', speed: 0.85 }      // 남성, 저음
    };
    
    // 선택된 음성에 따른 설정 적용
    if (voiceSettings[voice]) {
      selectedModel = voiceSettings[voice].model;
      speed = voiceSettings[voice].speed;
    } else {
      // 기본값
      selectedModel = 'tts-1';
      speed = 0.9;
    }
    
    // 언어 힌트 추가 (음성 인식 개선)
    processedText = `[Vietnamese language, ${voice} voice] ${processedText}`;
    
  } else if (language === 'Korean') {
    // 한국어 최적화
    speed = 0.95;
    selectedModel = 'tts-1-hd';
  }
  
  // TTS 요청 (재시도 로직)
  let attempts = 0;
  let audioBuffer = null;
  
  while (attempts < 2 && !audioBuffer) {
    attempts++;
    
    try {
      const ttsResponse = await fetch("https://api.openai.com/v1/audio/speech", {
        method: 'POST',
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          input: processedText,
          voice: selectedVoice,  // 사용자가 선택한 음성 사용
          response_format: 'mp3',
          speed: speed
        })
      });

      if (!ttsResponse.ok) {
        throw new Error(`TTS API 오류: ${ttsResponse.status}`);
      }

      const buffer = await ttsResponse.arrayBuffer();
      audioBuffer = buffer;
      console.log(`TTS 성공 (시도 ${attempts}): ${buffer.byteLength} bytes, 음성: ${selectedVoice}`);
      
    } catch (error) {
      console.error(`TTS 시도 ${attempts} 실패:`, error);
      if (attempts >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  if (!audioBuffer) {
    throw new Error("TTS 생성 실패");
  }
  
  return Buffer.from(audioBuffer);
}

exports.handler = async function(event, context) {
  const commonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: commonHeaders, body: '' };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: {...commonHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const { action, inputText, targetLang, voice, language } = JSON.parse(event.body || '{}');

    if (!API_KEY) {
      throw new Error("서버 설정 오류: OPENAI_API_KEY가 없습니다.");
    }

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
      
      const audioBuffer = await getTTSAudio(inputText, voice, language);
      
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