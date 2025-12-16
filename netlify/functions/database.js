// database.js - Supabase 연결 및 기본 CRUD 함수들
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Supabase 클라이언트 초기화
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || '';

// 환경변수 체크
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[Database] 필수 환경변수 누락:', {
    SUPABASE_URL: !!supabaseUrl,
    SUPABASE_SERVICE_KEY: !!supabaseServiceKey,
    SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY
  });
}

const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// JWT 및 암호화 키 체크
const JWT_SECRET = process.env.JWT_SECRET || 'default-jwt-secret-for-development-only';
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'default-encryption-secret';

// 암호화/복호화 함수들
const ENCRYPTION_KEY = crypto.scryptSync(process.env.ENCRYPTION_SECRET || 'default-secret', 'salt', 32);

function encryptApiKey(apiKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher('aes-256-cbc', ENCRYPTION_KEY);
  let encrypted = cipher.update(apiKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptApiKey(encryptedKey) {
  try {
    const textParts = encryptedKey.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = textParts.join(':');
    const decipher = crypto.createDecipher('aes-256-cbc', ENCRYPTION_KEY);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('API 키 복호화 실패:', error);
    return null;
  }
}

// 사용자 관련 함수들
async function createUser(email, password, displayName = null) {
  try {
    const hashedPassword = await bcrypt.hash(password, 12);

    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([
        {
          email: email.toLowerCase(),
          password_hash: hashedPassword,
          display_name: displayName
        }
      ])
      .select()
      .single();

    if (userError) throw userError;

    // 사용자 데이터 초기화
    const { error: dataError } = await supabase
      .from('user_data')
      .insert([{ user_id: user.id }]);

    if (dataError) console.error('사용자 데이터 초기화 실패:', dataError);

    return { success: true, user };
  } catch (error) {
    console.error('사용자 생성 실패:', error);
    return { success: false, error: error.message };
  }
}

async function authenticateUser(email, password) {
  // 🔧 방어 코드: Supabase 연결 확인
  if (!supabase) {
    console.error('[Auth] Critical: Supabase client is not initialized. Check environment variables.');
    return {
      success: false,
      error: '데이터베이스 연결 실패. 환경변수를 확인하세요. (SUPABASE_URL, SUPABASE_SERVICE_KEY)'
    };
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return { success: false, error: '사용자를 찾을 수 없습니다.' };
    }

    // 🎯 추가: 데이터베이스에서 password_hash가 비어있는 경우를 방지하는 방어 코드
    if (!user.password_hash) {
      console.error(`[Auth] Critical: User ${user.email} (ID: ${user.id}) has no password_hash.`);
      return { success: false, error: '사용자 계정에 문제가 있습니다. 관리자에게 문의하세요.' };
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return { success: false, error: '비밀번호가 일치하지 않습니다.' };
    }

    // JWT 토큰 생성
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'default-jwt-secret',
      { expiresIn: '7d' }
    );

    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isPremium: user.is_premium
      },
      token
    };
  } catch (error) {
    console.error('사용자 인증 실패:', error);
    return { success: false, error: error.message };
  }
}

async function verifyToken(token) {
  // 🔧 방어 코드: Supabase 연결 확인 (토큰 검증에는 필요 없지만 일관성을 위해)
  if (!supabase) {
    console.error('[Auth] Warning: Supabase client is not initialized during token verification.');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-jwt-secret');
    return { success: true, userId: decoded.userId, email: decoded.email };
  } catch (error) {
    return { success: false, error: '유효하지 않은 토큰입니다.' };
  }
}

// API 키 관리 함수들
async function saveUserApiKey(userId, apiKey, keyName = 'My API Key', provider = 'openai') {
  // 🔧 방어 코드: Supabase 연결 확인
  if (!supabase) {
    console.error('[API Keys] Critical: Supabase client is not initialized.');
    return { success: false, error: '데이터베이스 연결 실패. 환경변수를 확인하세요.' };
  }

  try {
    const encryptedKey = encryptApiKey(apiKey);

    const insertData = {
      user_id: userId,
      key_name: keyName,
      is_active: true
    };

    if (provider === 'openai') {
      insertData.encrypted_openai_key = encryptedKey;
    } else if (provider === 'google') {
      insertData.encrypted_google_key = encryptedKey;
    }

    const { data, error } = await supabase
      .from('user_api_keys')
      .upsert([insertData], {
        onConflict: 'user_id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) throw error;

    return { success: true, data };
  } catch (error) {
    console.error('API 키 저장 실패:', error);
    return { success: false, error: error.message };
  }
}

async function getUserApiKey(userId, provider = 'openai') {
  // 🔧 방어 코드: Supabase 연결 확인
  if (!supabase) {
    console.error('[API Keys] Critical: Supabase client is not initialized.');
    return { success: false, error: '데이터베이스 연결 실패. 환경변수를 확인하세요.' };
  }

  try {
    const { data, error } = await supabase
      .from('user_api_keys')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return { success: false, error: 'API 키를 찾을 수 없습니다.' };
    }

    let encryptedKey;
    if (provider === 'openai') {
      encryptedKey = data.encrypted_openai_key;
    } else if (provider === 'google') {
      encryptedKey = data.encrypted_google_key;
    }

    if (!encryptedKey) {
      return { success: false, error: `${provider} API 키가 등록되지 않았습니다.` };
    }

    const decryptedKey = decryptApiKey(encryptedKey);
    if (!decryptedKey) {
      return { success: false, error: 'API 키 복호화에 실패했습니다.' };
    }

    return { success: true, apiKey: decryptedKey };
  } catch (error) {
    console.error('API 키 조회 실패:', error);
    return { success: false, error: error.message };
  }
}

// 사용량 추적 함수들
async function trackUsage(userId, type, count = 1, cost = 0, provider = 'openai') {
  // 🔧 방어 코드: Supabase 연결 확인
  if (!supabase) {
    console.error('[Usage] Critical: Supabase client is not initialized.');
    return { success: false, error: '데이터베이스 연결 실패. 환경변수를 확인하세요.' };
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: existing, error: selectError } = await supabase
      .from('usage_logs')
      .select('*')
      .eq('user_id', userId)
      .eq('date', today)
      .single();

    if (selectError && selectError.code !== 'PGRST116') {
      throw selectError;
    }

    let updateData = {};
    if (type === 'translation') {
      updateData.translation_count = (existing?.translation_count || 0) + count;
    } else if (type === 'tts') {
      updateData.tts_count = (existing?.tts_count || 0) + count;
    }
    updateData.cost_usd = (existing?.cost_usd || 0) + cost;
    updateData.api_provider = provider;

    if (existing) {
      const { error: updateError } = await supabase
        .from('usage_logs')
        .update(updateData)
        .eq('id', existing.id);

      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await supabase
        .from('usage_logs')
        .insert([{
          user_id: userId,
          date: today,
          ...updateData
        }]);

      if (insertError) throw insertError;
    }

    return { success: true };
  } catch (error) {
    console.error('사용량 추적 실패:', error);
    return { success: false, error: error.message };
  }
}

// 공용 캐시 함수들
function generateCacheKey(sourceText, targetLang) {
  return crypto.createHash('sha256').update(`${sourceText}:${targetLang}`).digest('hex');
}

async function getPublicCache(sourceText, targetLang) {
  try {
    const hashKey = generateCacheKey(sourceText, targetLang);

    const { data, error } = await supabase
      .from('public_cache')
      .select('*')
      .eq('hash_key', hashKey)
      .single();

    if (error || !data) {
      return { success: false, error: '캐시 데이터 없음' };
    }

    // 히트 카운트 증가
    await supabase
      .from('public_cache')
      .update({
        hit_count: data.hit_count + 1,
        updated_at: new Date().toISOString()
      })
      .eq('id', data.id);

    return {
      success: true,
      data: {
        translation: data.translation,
        pronunciation: data.pronunciation,
        hitCount: data.hit_count + 1
      }
    };
  } catch (error) {
    console.error('공용 캐시 조회 실패:', error);
    return { success: false, error: error.message };
  }
}

async function setPublicCache(sourceText, targetLang, translation, pronunciation = '') {
  try {
    const hashKey = generateCacheKey(sourceText, targetLang);

    const { error } = await supabase
      .from('public_cache')
      .upsert([{
        hash_key: hashKey,
        source_text: sourceText,
        target_lang: targetLang,
        translation: translation,
        pronunciation: pronunciation,
        hit_count: 1,
        updated_at: new Date().toISOString()
      }], {
        onConflict: 'hash_key',
        ignoreDuplicates: false
      });

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('공용 캐시 저장 실패:', error);
    return { success: false, error: error.message };
  }
}

// 📝 번역 피드백 학습 함수들
async function saveFeedback(userId, originalText, originalTranslation, correctedTranslation, targetLang) {
  if (!supabase) {
    console.error('[Feedback] Critical: Supabase client is not initialized.');
    return { success: false, error: '데이터베이스 연결 실패.' };
  }

  try {
    const hashKey = crypto.createHash('sha256').update(`${originalText}:${targetLang}`).digest('hex');

    const { data, error } = await supabase
      .from('translation_feedback')
      .upsert([{
        user_id: userId,
        hash_key: hashKey,
        original_text: originalText,
        target_lang: targetLang,
        original_translation: originalTranslation,
        corrected_translation: correctedTranslation,
        updated_at: new Date().toISOString()
      }], {
        onConflict: 'hash_key,user_id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Feedback] 피드백 저장 완료: "${originalText.substring(0, 30)}..."`);
    return { success: true, data };
  } catch (error) {
    console.error('피드백 저장 실패:', error);
    return { success: false, error: error.message };
  }
}

async function getRelevantFeedback(originalText, targetLang, userId = null) {
  if (!supabase) {
    return { success: false, error: '데이터베이스 연결 실패.' };
  }

  try {
    const hashKey = crypto.createHash('sha256').update(`${originalText}:${targetLang}`).digest('hex');

    // 정확히 일치하는 피드백 먼저 조회
    let query = supabase
      .from('translation_feedback')
      .select('*')
      .eq('hash_key', hashKey);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: exactMatch, error: exactError } = await query.single();

    if (exactMatch && !exactError) {
      console.log(`[Feedback] 정확한 피드백 발견: "${originalText.substring(0, 20)}..."`);
      return {
        success: true,
        feedback: exactMatch,
        matchType: 'exact'
      };
    }

    // 유사 문장 피드백 조회 (최근 50개에서 검색)
    let recentQuery = supabase
      .from('translation_feedback')
      .select('*')
      .eq('target_lang', targetLang)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (userId) {
      recentQuery = recentQuery.eq('user_id', userId);
    }

    const { data: recentFeedback, error: recentError } = await recentQuery;

    if (recentFeedback && recentFeedback.length > 0) {
      // 간단한 유사도 검사 (공통 단어 비율)
      const inputWords = new Set(originalText.toLowerCase().split(/\s+/));
      let bestMatch = null;
      let bestScore = 0;

      for (const feedback of recentFeedback) {
        const feedbackWords = new Set(feedback.original_text.toLowerCase().split(/\s+/));
        const intersection = [...inputWords].filter(w => feedbackWords.has(w));
        const score = intersection.length / Math.max(inputWords.size, feedbackWords.size);

        if (score > 0.5 && score > bestScore) {
          bestScore = score;
          bestMatch = feedback;
        }
      }

      if (bestMatch) {
        console.log(`[Feedback] 유사 피드백 발견 (${(bestScore * 100).toFixed(0)}% 일치)`);
        return {
          success: true,
          feedback: bestMatch,
          matchType: 'similar',
          matchScore: bestScore
        };
      }
    }

    return { success: false, error: '관련 피드백 없음' };
  } catch (error) {
    console.error('피드백 조회 실패:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  supabase,
  createUser,
  authenticateUser,
  verifyToken,
  saveUserApiKey,
  getUserApiKey,
  trackUsage,
  getPublicCache,
  setPublicCache,
  encryptApiKey,
  decryptApiKey,
  saveFeedback,
  getRelevantFeedback
};