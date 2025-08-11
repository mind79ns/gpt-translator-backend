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

// ⭐ 수정된 getTTSAudio 함수 (베트남어 볼륨 증폭)
async function getTTSAudio(textToSpeak, voice, language) {
  // 베트남어 감지
  const vietnameseRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/;
  const isVietnamese = language === 'Vietnamese' || vietnameseRegex.test(textToSpeak);
  
  let processedText = textToSpeak;
  let selectedVoice = voice; // ⭐ 사용자 선택 음성 유지 (nova 강제 제거)
  let selectedModel = "tts-1-hd";
  let speed = 1.0;
  
  if (isVietnamese) {
    console.log("베트남어 TTS 최적화 처리");
    
    // ⭐ 핵심 개선: SSML로 볼륨 강력 증폭 (문자 변환 제거로 품질 향상)
    processedText = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="vi-VN">
      <prosody volume="+20dB" rate="0.9" pitch="+2%">
        ${textToSpeak}
      </prosody>
    </speak>`;
    
    selectedModel = 'tts-1-hd'; // 고품질 모델
    speed = 0.9; // 조금 느리게 (명확한 발음)
    
    console.log(`베트남어 SSML 적용: +20dB 볼륨 증폭`);
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
          voice: selectedVoice, // ⭐ 사용자 선택 음성 사용
          response_format: 'mp3',
          speed: speed
        })
      });

      if (!ttsResponse.ok) {
        throw new Error(`TTS API 오류: ${ttsResponse.status}`);
      }

      const buffer = await ttsResponse.arrayBuffer();
      audioBuffer = buffer;
      console.log(`TTS 성공 (시도 ${attempts}): ${buffer.byteLength} bytes`);
      
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