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
    // 한국어로 번역된 경우: 그대로
    pronunciation = translation;
  } else {
    // 외국어로 번역된 경우: 한글 발음 생성
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

  // 검증: 한국어 입력인데 발음이 원문과 같으면 재시도
  if (sourceLanguage === "Korean" && pronunciation === inputText && targetLang !== "Korean") {
    pronunciation = "발음 생성 오류";
    console.error("발음 생성 실패: 원문과 동일");
  }

  return {
    translation: translation,
    pronunciation: pronunciation || "발음 정보 없음"
  };
}

async function getTTSAudio(textToSpeak, voice) {
  // 베트남어 감지 및 전처리
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/;
  const isVietnamese = vietnameseRegex.test(textToSpeak);
  
  // 베트남어인 경우 특별 처리
  let processedText = textToSpeak;
  let selectedVoice = voice;
  let speed = 1.0;
  
  if (isVietnamese) {
    // 1. 베트남어 텍스트 정규화 (톤 마크 보존)
    processedText = textToSpeak.normalize('NFC');
    
    // 2. 베트남어에 최적화된 음성 선택 (nova가 가장 안정적)
    if (voice === 'echo' || voice === 'onyx' || voice === 'fable') {
      selectedVoice = 'nova';  // 여성 음성이 베트남어에 더 안정적
    }
    
    // 3. 속도 조정 (베트남어는 약간 천천히)
    speed = 0.9;
    
    // 4. 베트남어 문장 앞뒤에 구분자 추가 (TTS가 언어를 인식하도록)
    processedText = `[Vietnamese] ${processedText}`;
    
    console.log(`베트남어 TTS 처리: voice=${selectedVoice}, speed=${speed}`);
  }
  
  const ttsResponse = await fetch("https://api.openai.com/v1/audio/speech", {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1-hd",  // HD 모델 사용
      input: processedText,
      voice: selectedVoice,
      response_format: 'mp3',
      speed: speed
    })
  });

  if (!ttsResponse.ok) {
    const errorText = await ttsResponse.text();
    throw new Error(`TTS API 오류: ${ttsResponse.status} - ${errorText}`);
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
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
    const { action, inputText, targetLang, voice } = JSON.parse(event.body || '{}');

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
  
  // 언어 정보도 함께 전달받기 (프론트엔드에서)
  const { language } = JSON.parse(event.body || '{}');
  
  // TTS 생성 시 언어 정보 활용
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