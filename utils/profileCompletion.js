// Profile completion score calculation (Single source of truth for Web & Mobile)

const WEIGHTS = {
  basic: 20,
  resume: 20,
  skills: 15,
  experience: 20,
  education: 15,
  summary: 10,
};

/**
 * Calculates candidate profile completion percentage and missing sections.
 * 
 * Rules:
 * - basic (20%): name && phone && current_city
 * - resume (20%): resume_path is present
 * - skills (15%): at least 3 skills
 * - experience (20%): experience rows > 0 OR total_exp_months === 0 (Fresher is considered complete)
 * - education (15%): education rows > 0
 * - summary (10%): headline && summary
 * 
 * @param {Object} params
 * @param {Object} params.user { name, phone }
 * @param {Object} params.profile { headline, summary, current_city, resume_path, skills, total_exp_months }
 * @param {Array} params.experience Array of experience records
 * @param {Array} params.education Array of education records
 * @returns {{ percent: number, missing: string[] }}
 */
function calculateProfileCompletion({ user, profile, experience = [], education = [] }) {
  const missing = [];
  let percent = 0;

  // 1. Basic Details (20%)
  const hasBasic = Boolean(
    user?.name &&
    String(user.name).trim() &&
    user?.phone &&
    String(user.phone).trim() &&
    profile?.current_city &&
    String(profile.current_city).trim()
  );
  if (hasBasic) percent += WEIGHTS.basic;
  else missing.push('basic');

  // 2. Resume (20%)
  const hasResume = Boolean(profile?.resume_path && String(profile.resume_path).trim());
  if (hasResume) percent += WEIGHTS.resume;
  else missing.push('resume');

  // 3. Skills (15%) - At least 3 skills
  let skillList = [];
  if (Array.isArray(profile?.skills)) {
    skillList = profile.skills;
  } else if (typeof profile?.skills === 'string') {
    try {
      const parsed = JSON.parse(profile.skills);
      if (Array.isArray(parsed)) skillList = parsed;
    } catch (_) {}
  }
  const validSkills = skillList.filter((s) => typeof s === 'string' && s.trim().length > 0);
  const hasSkills = validSkills.length >= 3;
  if (hasSkills) percent += WEIGHTS.skills;
  else missing.push('skills');

  // 4. Experience (20%) - Rows > 0 OR Fresher (total_exp_months === 0)
  const isFresher = profile?.total_exp_months === 0 || profile?.total_exp_months === '0';
  const hasExperience = (Array.isArray(experience) && experience.length > 0) || isFresher;
  if (hasExperience) percent += WEIGHTS.experience;
  else missing.push('experience');

  // 5. Education (15%) - At least 1 education row
  const hasEducation = Array.isArray(education) && education.length > 0;
  if (hasEducation) percent += WEIGHTS.education;
  else missing.push('education');

  // 6. Professional Summary (10%) - Headline and Summary both present
  const hasSummary = Boolean(
    profile?.headline &&
    String(profile.headline).trim() &&
    profile?.summary &&
    String(profile.summary).trim()
  );
  if (hasSummary) percent += WEIGHTS.summary;
  else missing.push('summary');

  return {
    percent: Math.min(100, Math.max(0, percent)),
    missing,
  };
}

/**
 * Updates users.profile_completed flag based on percent >= 80.
 * 
 * @param {Object} dbPool mysql2 pool or connection
 * @param {string} userId
 * @param {number} percent
 */
async function syncUserProfileCompleted(dbPool, userId, percent) {
  const isCompleted = percent >= 80;
  try {
    await dbPool.query(
      'UPDATE users SET profile_completed = ? WHERE id = ?',
      [isCompleted, userId]
    );
  } catch (err) {
    console.warn(`Failed to sync profile_completed for user ${userId}:`, err.message);
  }
  return isCompleted;
}

module.exports = {
  WEIGHTS,
  calculateProfileCompletion,
  syncUserProfileCompleted,
};
