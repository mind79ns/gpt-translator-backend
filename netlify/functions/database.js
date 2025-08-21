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
    SUPABASE_SERVICE_KEY: !!supabaseServiceKey
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
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-jwt-secret');
    return { success: true, userId: decoded.userId, email: decoded.email };
  } catch (error) {
    return { success: false, error: '유효하지 않은 토큰입니다.' };
  }
}

// API 키 관리 함수들
async function saveUserApiKey(userId, apiKey, keyName = 'My API Key', provider = 'openai') {
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
// ===================================================
// ⚙️ 사용자 설정 관리 함수들
// ===================================================

// 사용자 설정 저장
async function saveUserSettings(userId, settings) {
  try {
    if (!supabase) {
      return { success: false, error: '데이터베이스 연결 실패' };
    }

    const { data, error } = await supabase
      .from('user_settings')
      .upsert([{
        user_id: userId,
        tts_engine: settings.ttsEngine || 'auto',
        voice_selection: settings.voiceSelection || 'nova',
        google_voice: settings.googleVoice || 'vi-VN-Standard-A',
        volume: settings.volume || 0.8,
        source_lang: settings.sourceLang || 'Korean',
        target_lang: settings.targetLang || 'Vietnamese',
        theme: settings.theme || 'light',
        pronunciation_enabled: settings.pronunciationEnabled !== false,
        auto_threshold: settings.autoThreshold || 50,
        daily_budget: settings.dailyBudget || 1.00,
        monthly_budget: settings.monthlyBudget || 30.00
      }], {
        onConflict: 'user_id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) throw error;

    return { success: true, settings: data };
  } catch (error) {
    console.error('사용자 설정 저장 실패:', error);
    return { success: false, error: error.message };
  }
}

// 사용자 설정 로드
async function getUserSettings(userId) {
  try {
    if (!supabase) {
      return { success: false, error: '데이터베이스 연결 실패' };
    }

    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // 데이터가 없으면 기본값 반환
    if (!data) {
      return {
        success: true,
        settings: {
          ttsEngine: 'auto',
          voiceSelection: 'nova',
          googleVoice: 'vi-VN-Standard-A',
          volume: 0.8,
          sourceLang: 'Korean',
          targetLang: 'Vietnamese',
          theme: 'light',
          pronunciationEnabled: true,
          autoThreshold: 50,
          dailyBudget: 1.00,
          monthlyBudget: 30.00
        }
      };
    }

    return {
      success: true,
      settings: {
        ttsEngine: data.tts_engine,
        voiceSelection: data.voice_selection,
        googleVoice: data.google_voice,
        volume: data.volume,
        sourceLang: data.source_lang,
        targetLang: data.target_lang,
        theme: data.theme,
        pronunciationEnabled: data.pronunciation_enabled,
        autoThreshold: data.auto_threshold,
        dailyBudget: data.daily_budget,
        monthlyBudget: data.monthly_budget
      }
    };
  } catch (error) {
    console.error('사용자 설정 로드 실패:', error);
    return { success: false, error: error.message };
  }
}

// ===================================================
// 🧠 AI 설정 관리 함수들
// ===================================================

// AI 설정 저장
async function saveUserAISettings(userId, aiSettings) {
  try {
    if (!supabase) {
      return { success: false, error: '데이터베이스 연결 실패' };
    }

    const { data, error } = await supabase
      .from('user_ai_settings')
      .upsert([{
        user_id: userId,
        ai_context_mode: aiSettings.aiContextMode || false,
        translation_style: aiSettings.translationStyle || 'balanced',
        quality_level: aiSettings.qualityLevel || 3,
        terminology_dict: aiSettings.terminologyDict || {},
        translation_context: aiSettings.translationContext || []
      }], {
        onConflict: 'user_id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) throw error;

    return { success: true, aiSettings: data };
  } catch (error) {
    console.error('AI 설정 저장 실패:', error);
    return { success: false, error: error.message };
  }
}

// AI 설정 로드
async function getUserAISettings(userId) {
  try {
    if (!supabase) {
      return { success: false, error: '데이터베이스 연결 실패' };
    }

    const { data, error } = await supabase
      .from('user_ai_settings')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // 데이터가 없으면 기본값 반환
    if (!data) {
      return {
        success: true,
        aiSettings: {
          aiContextMode: false,
          translationStyle: 'balanced',
          qualityLevel: 3,
          terminologyDict: {},
          translationContext: []
        }
      };
    }

    return {
      success: true,
      aiSettings: {
        aiContextMode: data.ai_context_mode,
        translationStyle: data.translation_style,
        qualityLevel: data.quality_level,
        terminologyDict: data.terminology_dict,
        translationContext: data.translation_context
      }
    };
  } catch (error) {
    console.error('AI 설정 로드 실패:', error);
    return { success: false, error: error.message };
  }
}

// ===================================================
// 📚 번역 기록 관리 함수들
// ===================================================

// 번역 기록 저장
async function saveTranslationHistory(userId, historyData) {
  try {
    if (!supabase) {
      return { success: false, error: '데이터베이스 연결 실패' };
    }

    const { data, error } = await supabase
      .from('user_translation_history')
      .insert([{
        user_id: userId,
        source_text: historyData.sourceText,
        translation: historyData.translation,
        source_lang: historyData.sourceLang,
        target_lang: historyData.targetLang,
        is_ai_translation: historyData.isAI || false
      }])
      .select()
      .single();

    if (error) throw error;

    // 50개 이상이면 오래된 기록 삭제
    const { data: countData, error: countError } = await supabase
      .from('user_translation_history')
      .select('id', { count: 'exact' })
      .eq('user_id', userId);

    if (!countError && countData && countData.length > 50) {
      const { error: deleteError } = await supabase
        .from('user_translation_history')
        .delete()
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(countData.length - 50);

      if (deleteError) console.error('오래된 번역 기록 삭제 실패:', deleteError);
    }

    return { success: true, history: data };
  } catch (error) {
    console.error('번역 기록 저장 실패:', error);
    return { success: false, error: error.message };
  }
}

// 번역 기록 로드
async function getUserTranslationHistory(userId, limit = 50) {
  try {
    if (!supabase) {
      return { success: false, error: '데이터베이스 연결 실패' };
    }

    const { data, error } = await supabase
      .from('user_translation_history')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return { success: true, history: data || [] };
  } catch (error) {
    console.error('번역 기록 로드 실패:', error);
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
  // 기존 단어장 함수들
  saveUserVocabulary,
  getUserVocabulary,
  addUserWord,
  updateUserWord,
  deleteUserWord,
  // ✨ 새로 추가되는 함수들
  saveUserSettings,
  getUserSettings,
  saveUserAISettings,
  getUserAISettings,
  saveTranslationHistory,
  getUserTranslationHistory
};