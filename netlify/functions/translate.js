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
  let selectedVoice = voice;  // 사용자 선택 유지!
  let selectedModel = "tts-1-hd";
  let speed = 1.0;
  
  if (isVietnamese) {
    console.log("베트남어 TTS 처리 - 사용자 선택 음성:", voice);
    
    // 베트남어 텍스트를 영어식 발음으로 변환 (안정성 향상)
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
    
    // ⭐ 중요: nova 강제 고정 제거! 사용자 선택 음성 사용
    // selectedVoice = 'nova';  // ❌ 이 줄 삭제!
    
    // 베트남어 최적 설정 (음성은 사용자 선택 유지)
    processedText = `${processedText}. ${processedText}`;  // 텍스트 2번 반복으로 볼륨 효과

selectedModel = 'tts-1-hd';  // ⭐ HD 모델로 변경 (더 큰 소리)
speed = 0.9;  // 조금 느리게 (더 명확한 발음)
    
    console.log(`베트남어 TTS: voice=${selectedVoice}, model=${selectedModel}, speed=${speed}`);
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
          voice: selectedVoice,  // 사용자 선택 음성 사용
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