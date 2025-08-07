exports.handler = async function(event, context) {
  // 함수 시작 로그
  console.log('=== 함수 시작 ===');
  console.log('HTTP Method:', event.httpMethod);
  console.log('Headers:', JSON.stringify(event.headers));
  console.log('Body:', event.body);
  
  // CORS 헤더 설정
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // OPTIONS 요청 처리 (프리플라이트)
  if (event.httpMethod === "OPTIONS") {
    console.log('OPTIONS 요청 처리됨');
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== "POST") {
    console.log('잘못된 HTTP 메소드:', event.httpMethod);
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // 요청 본문 파싱
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid JSON in request body" }),
      };
    }

    const { inputText, targetLang } = body;
    const API_KEY = process.env.OPENAI_API_KEY;

    // API 키 확인
    if (!API_KEY) {
      console.error("OPENAI_API_KEY가 설정되지 않았습니다.");
      console.log('환경 변수:', Object.keys(process.env));
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "서버 설정 오류: API 키 없음" }),
      };
    }

    console.log('API 키 존재 확인:', API_KEY ? 'YES' : 'NO');
    console.log('API 키 앞 10글자:', API_KEY ? API_KEY.substring(0, 10) + '...' : 'NONE');

    if (!inputText || !targetLang) {
      console.log('입력 데이터 부족:', { inputText, targetLang });
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "inputText 또는 targetLang이 없습니다." }),
      };
    }

    console.log(`번역 요청: "${inputText}" -> ${targetLang}`);

    // 번역 요청
    const prompt = `Translate the following sentence into ${targetLang}. Only return the translated sentence. No explanation.\n\n"${inputText}"`;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API 오류:", response.status, errorText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: `번역 API 오류: ${response.status}` }),
      };
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "번역 결과가 올바르지 않습니다." }),
      };
    }

    const translation = data.choices[0].message.content.trim();
    console.log(`번역 결과: ${translation}`);

    // 발음 요청
    const pronPrompt = `Write the Korean-style pronunciation (Hangul only) of the following ${targetLang} sentence:\n"${translation}"\n\nJust output the Hangul only.`;
    const pronResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: pronPrompt }],
        temperature: 0.2
      })
    });

    let pronunciation = "";
    if (pronResponse.ok) {
      const pronData = await pronResponse.json();
      if (pronData.choices && pronData.choices[0] && pronData.choices[0].message) {
        pronunciation = pronData.choices[0].message.content.trim();
      }
    } else {
      console.error("발음 API 오류:", pronResponse.status);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ translation, pronunciation }),
    };
  } catch (err) {
    console.error("서버 오류:", err);
    console.error("스택 트레이스:", err.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "서버 내부 오류가 발생했습니다.",
        details: err.message 
      }),
    };
  }
};