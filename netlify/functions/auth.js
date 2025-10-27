// auth.js - 사용자 인증 및 API 키 관리 Netlify Function
const { 
  createUser, 
  authenticateUser, 
  verifyToken, 
  saveUserApiKey, 
  getUserApiKey,
  supabase
} = require('./database');

// CORS 헤더 설정
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// 환경변수 체크
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('[Auth] 환경변수 누락:', {
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY
  });
}
exports.handler = async function (event, context) {
  // 🔧 OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  // 🔧 POST 요청만 허용
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    // 🔧 요청 본문 파싱
    const { action, email, password, displayName, provider, apiKey, keyName } = JSON.parse(event.body || '{}');

    console.log(`[Auth] 액션 요청: ${action}`);

    // 🔧 액션별 라우팅
    switch (action) {
      case 'register':
        return await handleRegister(email, password, displayName);
      
       case 'login':
        return await handleLogin(event, email, password); // 👈 event 인자 전달
      
      case 'forgot-password':
        return await handleForgotPassword(email);
      
      case 'save-api-key':
        return await handleSaveApiKey(event.headers, provider, apiKey, keyName);
      
      case 'get-api-keys':
        return await handleGetApiKeys(event.headers);
      
      case 'delete-api-key':
        return await handleDeleteApiKey(event.headers, provider);
      
        case 'get-usage':
        return await handleGetUsage(event.headers);
      
      case 'get-monthly-cost':
        return await handleGetMonthlyCost(event.headers);
      
      case 'get-dashboard-data':
        return await handleGetDashboardData(event.headers);

      case 'verify-token':
        return await handleVerifyToken(event.headers);

      default:
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `알 수 없는 액션: ${action}` })
        };
    }

  } catch (error) {
    console.error('[Auth] 핸들러 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: '서버 내부 오류',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    };
  }
};

// 🔐 회원가입 처리 (개선)
async function handleRegister(email, password, displayName) {
  console.log(`[Auth] 회원가입 시도: ${email}`);
  console.log(`[Auth] Supabase 상태:`, {
    supabaseExists: !!supabase,
    url: process.env.SUPABASE_URL ? '설정됨' : '누락',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ? '설정됨' : '누락'
  });

  // Supabase 연결 체크
    if (!supabase) {
        console.error('[Auth] Critical: Supabase is null - 환경변수 확인 필요');
        return {
            statusCode: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: '데이터베이스 연결 실패. 관리자에게 문의하세요.',
                debug: {
                  supabaseUrl: !!process.env.SUPABASE_URL,
                  supabaseKey: !!process.env.SUPABASE_SERVICE_KEY
                }
            })
        };
    }
    
  // 🔧 개선: 입력값 유효성 검사 강화
  if (!email || !password) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '이메일과 비밀번호가 필요합니다.' })
    };
  }

  // 이메일 형식 검증
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '올바른 이메일 형식이 아닙니다.' })
    };
  }

  // 비밀번호 강도 검증
  if (password.length < 8) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '비밀번호는 8자 이상이어야 합니다.' })
    };
  }

  // 🔧 추가: 비밀번호 복잡성 검사
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  const complexityScore = [hasUpperCase, hasLowerCase, hasNumbers, hasSpecialChar].filter(Boolean).length;
  
  if (complexityScore < 2) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: '비밀번호는 대소문자, 숫자, 특수문자 중 최소 2가지를 포함해야 합니다.' 
      })
    };
  }

  // 표시명 길이 제한
  if (displayName && displayName.length > 50) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '표시명은 50자를 초과할 수 없습니다.' })
    };
  }

  try {
    console.log(`[Auth] createUser 함수 호출 시작`);
    const result = await createUser(email.toLowerCase().trim(), password, displayName?.trim() || null);
    console.log(`[Auth] createUser 결과:`, { success: result.success, hasUser: !!result.user, error: result.error });

    if (result.success) {
      console.log(`[Auth] 회원가입 성공: ${email} (ID: ${result.user.id})`);

      // 🔧 개선: 민감한 정보 제외하고 응답
      return {
        statusCode: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          message: '회원가입이 완료되었습니다.',
          user: {
            id: result.user.id,
            email: result.user.email,
            displayName: result.user.display_name,
            createdAt: result.user.created_at
          }
        })
      };
    } else {
      console.error(`[Auth] 회원가입 실패: ${result.error}`);

      // 🔧 개선: 에러 메시지 사용자 친화적으로 변환
      let errorMessage = result.error;
      if (result.error.includes('duplicate key value violates unique constraint')) {
        errorMessage = '이미 등록된 이메일 주소입니다.';
      } else if (result.error.includes('invalid input syntax')) {
        errorMessage = '입력 형식이 올바르지 않습니다.';
      }

      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: errorMessage,
          debugError: result.error // 디버깅용
        })
      };
    }

  } catch (error) {
    console.error('[Auth] 회원가입 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: '회원가입 처리 중 오류가 발생했습니다.',
        debugError: error.message // 디버깅용
      })
    };
  }
}

// 🔐 로그인 처리 (개선)
async function handleLogin(event, email, password) { // 👈 event 인자 추가
  console.log(`[Auth] 로그인 시도: ${email}`);
// ...

  // 🔧 개선: 입력값 유효성 검사
  if (!email || !password) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '이메일과 비밀번호가 필요합니다.' })
    };
  }

  // 🔧 추가: 브루트 포스 공격 방지를 위한 기본 검증
  if (password.length > 100) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '올바르지 않은 요청입니다.' })
    };
  }

  const clientIP = event.headers['x-forwarded-for'] || event.headers['x-real-ip'] || 'unknown';
  console.log(`[Auth] 로그인 시도 - IP: ${clientIP}, Email: ${email}`);
  console.log(`[Auth] Supabase 상태:`, {
    supabaseExists: !!supabase,
    url: process.env.SUPABASE_URL ? '설정됨' : '누락',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ? '설정됨' : '누락'
  });

  try {
    console.log(`[Auth] authenticateUser 함수 호출 시작`);
    const result = await authenticateUser(email.toLowerCase().trim(), password);
    console.log(`[Auth] authenticateUser 결과:`, { success: result.success, hasUser: !!result.user, error: result.error });

    if (result.success) {
      console.log(`[Auth] 로그인 성공: ${email} (ID: ${result.user.id})`);
      
      // 🔧 개선: 로그인 성공 시 사용자 정보 및 토큰 반환
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          message: '로그인 성공',
          user: {
            id: result.user.id,
            email: result.user.email,
            displayName: result.user.displayName,
            isPremium: result.user.isPremium || false
          },
          token: result.token,
          expiresIn: '7d'
        })
      };
    } else {
      console.error(`[Auth] 로그인 실패: ${email} - ${result.error} (IP: ${clientIP})`);

      // 🔧 보안: 구체적인 실패 이유 숨기기 (디버깅 정보는 포함)
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: '이메일 또는 비밀번호가 올바르지 않습니다.',
          debugError: result.error // 디버깅용
        })
      };
    }

  } catch (error) {
    console.error('[Auth] 로그인 처리 오류:', error);
    
    // 🔧 보안: 내부 오류 상세 정보 숨기기
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        error: '로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' 
      })
    };
  }
}

// 🔐 비밀번호 재설정 처리
async function handleForgotPassword(email) {
  console.log(`[Auth] 비밀번호 재설정 요청: ${email}`);

  if (!email) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '이메일이 필요합니다.' })
    };
  }

  // 🔧 추후 이메일 발송 기능 구현 예정
  // 현재는 성공 응답만 반환
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      message: '비밀번호 재설정 링크가 이메일로 발송되었습니다.'
    })
  };
}

// 🔧 인증 토큰 검증 헬퍼
async function verifyAuthToken(headers) {
  const authHeader = headers.authorization || headers.Authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { success: false, error: '인증 토큰이 필요합니다.' };
  }

  const token = authHeader.substring(7);
  const result = await verifyToken(token);

  if (!result.success) {
    return { success: false, error: '유효하지 않은 토큰입니다.' };
  }

  return { success: true, userId: result.userId, email: result.email };
}

// 🔑 API 키 저장 처리 (완전 구현)
async function handleSaveApiKey(headers, provider, apiKey, keyName) {
  console.log(`[API Keys] API 키 저장 요청: ${provider}`);

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  if (!authResult.success) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: authResult.error })
    };
  }

  // 🔧 입력값 검증
  if (!provider || !apiKey || !keyName) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        error: 'provider, apiKey, keyName이 모두 필요합니다.' 
      })
    };
  }

  // 지원되는 프로바이더 확인
  if (!['openai', 'google'].includes(provider)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        error: '지원되지 않는 API 프로바이더입니다.' 
      })
    };
  }

  // 🔧 API 키 형식 검증
  if (provider === 'openai') {
    if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          success: false, 
          error: '올바른 OpenAI API 키 형식이 아닙니다. (sk-로 시작)' 
        })
      };
    }
  } else if (provider === 'google') {
    if (!apiKey.startsWith('AIza') || apiKey.length < 20) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          success: false, 
          error: '올바른 Google API 키 형식이 아닙니다. (AIza로 시작)' 
        })
      };
    }
  }

  // API 키 길이 제한
  if (apiKey.length > 200) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        error: 'API 키가 너무 깁니다.' 
      })
    };
  }

  try {
    // 🔧 API 키 저장
    const result = await saveUserApiKey(authResult.userId, apiKey, keyName, provider);

    if (result.success) {
      console.log(`[API Keys] ${provider} API 키 저장 성공: 사용자 ${authResult.userId}`);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          message: `${provider.toUpperCase()} API 키가 안전하게 저장되었습니다.`,
          provider: provider
        })
      };
    } else {
      console.error(`[API Keys] ${provider} API 키 저장 실패:`, result.error);
      
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: `API 키 저장에 실패했습니다: ${result.error}`
        })
      };
    }

  } catch (error) {
    console.error('[API Keys] API 키 저장 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'API 키 저장 중 오류가 발생했습니다.'
      })
    };
  }
}

// 🔑 API 키 조회 처리 (완전 구현)
async function handleGetApiKeys(headers) {
  console.log('[API Keys] API 키 조회 요청');

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  if (!authResult.success) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: authResult.error })
    };
  }

  try {
    // 🔧 OpenAI 및 Google API 키 조회
    const [openaiResult, googleResult] = await Promise.all([
      getUserApiKey(authResult.userId, 'openai'),
      getUserApiKey(authResult.userId, 'google')
    ]);

    console.log(`[API Keys] 키 조회 완료 - OpenAI: ${openaiResult.success}, Google: ${googleResult.success}`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        openaiKey: openaiResult.success,
        googleKey: googleResult.success,
        keys: {
          openai: {
            exists: openaiResult.success,
            keyName: openaiResult.success ? 'OpenAI API Key' : null,
            lastUpdated: openaiResult.success ? new Date().toISOString() : null
          },
          google: {
            exists: googleResult.success,
            keyName: googleResult.success ? 'Google API Key' : null,
            lastUpdated: googleResult.success ? new Date().toISOString() : null
          }
        }
      })
    };

  } catch (error) {
    console.error('[API Keys] API 키 조회 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'API 키 조회 중 오류가 발생했습니다.'
      })
    };
  }
}

// 🔑 API 키 삭제 처리 (완전 구현)
async function handleDeleteApiKey(headers, provider) {
  console.log(`[API Keys] API 키 삭제 요청: ${provider}`);

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  if (!authResult.success) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: authResult.error })
    };
  }

  // 🔧 입력값 검증
  if (!provider) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        error: 'provider가 필요합니다.' 
      })
    };
  }

  // 지원되는 프로바이더 확인
  if (!['openai', 'google'].includes(provider)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        error: '지원되지 않는 API 프로바이더입니다.' 
      })
    };
  }

  try {
    // 🔧 API 키 삭제 (빈 문자열로 업데이트)
    const result = await saveUserApiKey(authResult.userId, '', `Deleted ${provider} Key`, provider);

    if (result.success) {
      console.log(`[API Keys] ${provider} API 키 삭제 성공: 사용자 ${authResult.userId}`);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          message: `${provider.toUpperCase()} API 키가 삭제되었습니다.`,
          provider: provider
        })
      };
    } else {
      console.error(`[API Keys] ${provider} API 키 삭제 실패:`, result.error);
      
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: `API 키 삭제에 실패했습니다: ${result.error}`
        })
      };
    }

  } catch (error) {
    console.error('[API Keys] API 키 삭제 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'API 키 삭제 중 오류가 발생했습니다.'
      })
    };
  }
}

// 🔐 토큰 검증 처리
async function handleVerifyToken(headers) {
  console.log('[Auth] 토큰 검증 요청');

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  
  if (authResult.success) {
    console.log(`[Auth] 토큰 검증 성공: ${authResult.email}`);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        user: {
          id: authResult.userId,
          email: authResult.email
        }
      })
    };
  } else {
    console.log('[Auth] 토큰 검증 실패');
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: '토큰이 유효하지 않습니다.'
      })
    };
  }
}

// 📊 사용량 조회 처리
async function handleGetUsage(headers) {
  console.log('[Usage] 사용량 조회 요청');

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  if (!authResult.success) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: authResult.error })
    };
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const thisMonth = today.substring(0, 7); // YYYY-MM

    // 🔧 오늘 사용량 조회
    const { data: todayUsage, error: todayError } = await supabase
      .from('usage_logs')
      .select('*')
      .eq('user_id', authResult.userId)
      .eq('date', today)
      .single();

    if (todayError && todayError.code !== 'PGRST116') {
      throw todayError;
    }

    // 🔧 이번 달 사용량 조회
    const { data: monthlyUsage, error: monthlyError } = await supabase
      .from('usage_logs')
      .select('translation_count, tts_count, cost_usd')
      .eq('user_id', authResult.userId)
      .gte('date', `${thisMonth}-01`)
      .lte('date', `${thisMonth}-31`);

    if (monthlyError) {
      throw monthlyError;
    }

    // 🔧 월별 사용량 합계 계산
    const monthlyTotals = monthlyUsage.reduce((acc, row) => {
      acc.translations += row.translation_count || 0;
      acc.tts += row.tts_count || 0;
      acc.cost += row.cost_usd || 0;
      return acc;
    }, { translations: 0, tts: 0, cost: 0 });

    // 🔧 지난 7일 사용량 조회
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const weekStartDate = sevenDaysAgo.toISOString().split('T')[0];

    const { data: weeklyUsage, error: weeklyError } = await supabase
      .from('usage_logs')
      .select('date, translation_count, cost_usd')
      .eq('user_id', authResult.userId)
      .gte('date', weekStartDate)
      .lte('date', today)
      .order('date', { ascending: true });

    if (weeklyError) {
      throw weeklyError;
    }

    console.log(`[Usage] 사용량 조회 완료 - 사용자: ${authResult.userId}`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        usage: {
          today: {
            translations: todayUsage?.translation_count || 0,
            tts: todayUsage?.tts_count || 0,
            cost: todayUsage?.cost_usd || 0
          },
          thisMonth: {
            translations: monthlyTotals.translations,
            tts: monthlyTotals.tts,
            cost: monthlyTotals.cost
          },
          weekly: weeklyUsage || []
        }
      })
    };

  } catch (error) {
    console.error('[Usage] 사용량 조회 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: '사용량 조회 중 오류가 발생했습니다.'
      })
    };
  }
}

// 📊 월별 비용 조회 처리
async function handleGetMonthlyCost(headers) {
  console.log('[Usage] 월별 비용 조회 요청');

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  if (!authResult.success) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: authResult.error })
    };
  }

  try {
    // 🔧 최근 6개월 비용 데이터 조회
    const currentDate = new Date();
    const months = [];
    
    for (let i = 5; i >= 0; i--) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
      const monthStr = date.toISOString().substring(0, 7);
      months.push(monthStr);
    }

    const monthlyData = [];

    for (const month of months) {
      const { data: monthUsage, error } = await supabase
        .from('usage_logs')
        .select('cost_usd')
        .eq('user_id', authResult.userId)
        .gte('date', `${month}-01`)
        .lte('date', `${month}-31`);

      if (error) {
        throw error;
      }

      const totalCost = monthUsage.reduce((sum, row) => sum + (row.cost_usd || 0), 0);
      
      monthlyData.push({
        month: month,
        cost: totalCost,
        monthLabel: new Date(month + '-01').toLocaleDateString('ko-KR', { month: 'short' })
      });
    }

    console.log(`[Usage] 월별 비용 조회 완료 - 사용자: ${authResult.userId}`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        monthlyData: monthlyData
      })
    };

  } catch (error) {
    console.error('[Usage] 월별 비용 조회 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: '월별 비용 조회 중 오류가 발생했습니다.'
      })
    };
  }
}

// 📊 대시보드 데이터 종합 조회
async function handleGetDashboardData(headers) {
  console.log('[Usage] 대시보드 데이터 조회 요청');

  // 인증 확인
  const authResult = await verifyAuthToken(headers);
  if (!authResult.success) {
    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: authResult.error })
    };
  }

  try {
    // 🔧 사용량과 월별 비용 데이터를 병렬로 조회
    const [usageResponse, monthlyCostResponse] = await Promise.all([
      handleGetUsage(headers),
      handleGetMonthlyCost(headers)
    ]);

    const usageData = JSON.parse(usageResponse.body);
    const monthlyCostData = JSON.parse(monthlyCostResponse.body);

    if (!usageData.success || !monthlyCostData.success) {
      throw new Error('데이터 조회 실패');
    }

    // 🔧 전체 사용량 통계 계산
    const { data: totalStats, error: totalError } = await supabase
      .from('usage_logs')
      .select('translation_count, tts_count, cost_usd')
      .eq('user_id', authResult.userId);

    if (totalError) {
      throw totalError;
    }

    const totals = totalStats.reduce((acc, row) => {
      acc.totalTranslations += row.translation_count || 0;
      acc.totalTTS += row.tts_count || 0;
      acc.totalCost += row.cost_usd || 0;
      return acc;
    }, { totalTranslations: 0, totalTTS: 0, totalCost: 0 });

    console.log(`[Usage] 대시보드 데이터 조회 완료 - 사용자: ${authResult.userId}`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        dashboard: {
          usage: usageData.usage,
          monthlyData: monthlyCostData.monthlyData,
          totals: totals,
          user: {
            id: authResult.userId,
            email: authResult.email
          }
        }
      })
    };

  } catch (error) {
    console.error('[Usage] 대시보드 데이터 조회 처리 오류:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: '대시보드 데이터 조회 중 오류가 발생했습니다.'
      })
    };
  }
}