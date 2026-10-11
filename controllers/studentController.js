'use strict';

const { query } = require('../config/database');
const qrService = require('../services/qrService');
const verificationService = require('../services/verificationService');
const aiService = require('../services/aiService');

/**
 * A student sees ONLY their own certificates. The match uses the account's
 * name/email ownership via student_id linkage established at issuance time -
 * never a client-supplied ID.
 */

async function myCertificates(req, res, next) {
  try {
    const result = await query(
      `SELECT c.*, i.name AS institution_name, i.verification_status AS institution_status
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.student_id = $1
        ORDER BY c.created_at DESC`,
      [req.user.id]
    );

    const certificates = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        certificateId: row.certificate_id,
        degree: row.degree,
        department: row.department,
        certificateType: row.certificate_type,
        academicYear: row.academic_year,
        issueDate: row.issue_date,
        status: row.status,
        blockchainStatus: row.blockchain_status,
        documentHash: row.document_hash,
        institution: row.institution_name,
        qrDataUrl: await qrService.generateQrDataUrl(row.certificate_id).catch(() => null),
        verificationUrl: qrService.verificationUrl(row.certificate_id),
      }))
    );

    return res.json({
      success: true,
      data: {
        certificates,
        stats: {
          total: certificates.length,
          active: certificates.filter((c) => c.status === 'ACTIVE').length,
          revoked: certificates.filter((c) => c.status === 'REVOKED').length,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/students/me/credentials - public-safe credential profile data */
async function myCredentials(req, res, next) {
  try {
    const userResult = await query('SELECT id, name FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const result = await query(
      `SELECT c.certificate_id, c.certificate_type, c.degree, c.issue_date, c.status,
              i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.student_id = $1
        ORDER BY c.issue_date DESC`,
      [req.user.id]
    );

    const credentials = await Promise.all(
      result.rows.map(async (row) => ({
        certificateId: row.certificate_id,
        certificateType: row.certificate_type,
        credential: row.degree,
        institution: row.institution_name,
        issueDate: row.issue_date,
        verificationStatus: row.status,
        verificationUrl: qrService.verificationUrl(row.certificate_id),
      }))
    );

    return res.json({
      success: true,
      data: {
        profile: {
          holderName: user.name,
          profileUrl: `${(process.env.BASE_URL || '').replace(/\/$/, '')}/credential-profile.html?student=${user.id}`,
          credentials,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/students/:id/public-profile - public-safe subset, no private data */
async function publicProfile(req, res, next) {
  try {
    const studentId = Number(req.params.id);
    const userResult = await query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [studentId, 'STUDENT']);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'Credential profile not found.' });

    const result = await query(
      `SELECT c.certificate_id, c.certificate_type, c.degree, c.issue_date, c.status,
              i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.student_id = $1
        ORDER BY c.issue_date DESC`,
      [studentId]
    );

    const credentials = await Promise.all(
      result.rows.map(async (row) => ({
        certificateId: row.certificate_id,
        certificateType: row.certificate_type,
        credential: row.degree,
        institution: row.institution_name,
        issueDate: row.issue_date,
        verificationStatus: row.status,
        verificationUrl: qrService.verificationUrl(row.certificate_id),
      }))
    );

    return res.json({
      success: true,
      data: {
        profile: {
          holderName: user.name,
          credentials,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/students/me/history - verification events on my certificates */
async function myHistory(req, res, next) {
  try {
    const result = await query(
      `SELECT v.id, v.certificate_ref, v.verification_method, v.final_result, v.created_at
         FROM verifications v JOIN certificates c ON c.id = v.certificate_id
        WHERE c.student_id = $1
        ORDER BY v.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    return res.json({ success: true, data: { history: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/students/me/resume
 *
 * Builds the resume from TWO real data sources:
 * 1. The student's questionnaire answers (student_resume_profiles) - personal
 *    info, skills, projects, experience, certifications, career preferences.
 *    The student enters these themselves; the server whitelists and caps them.
 * 2. Platform-verified certificates (certificates table) - these stay
 *    authoritative for everything blockchain-related.
 * A resume can be built with only one of the two sources; each section is
 * rendered only when data exists, and the response reports its sources.
 */
async function buildResume(req, res, next) {
  try {
    const userResult = await query('SELECT id, name, email, registration_number FROM users WHERE id = $1 AND role = $2', [req.user.id, 'STUDENT']);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const certResult = await query(
      `SELECT c.certificate_id, c.certificate_type, c.degree, c.department, c.semester,
              c.academic_year, c.marks, c.issue_date, c.status, c.blockchain_status,
              i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.student_id = $1
        ORDER BY c.issue_date DESC, c.semester NULLS LAST`,
      [req.user.id]
    );

    const certs = certResult.rows;

    // Questionnaire answers (may be empty - certificates alone still work).
    const profileResult = await query('SELECT answers FROM student_resume_profiles WHERE student_id = $1', [req.user.id]);
    const answers = (profileResult.rows[0] && profileResult.rows[0].answers) || {};

    if (!certs.length && !Object.keys(answers).length) {
      return res.json({
        success: true,
        data: { resume: null, emptyState: 'Nothing to build a resume from yet. Fill in your resume details (personal information, skills, projects) and once an institution issues you a verified certificate it will also be included.' },
      });
    }

    const chainVerified = (c) => c.blockchain_status === 'registered' && c.status === 'ACTIVE';

    const education = certs.map((c) => ({
      certificateId: c.certificate_id,
      credential: c.degree,
      department: c.department || null,
      semester: c.semester || null,
      institution: c.institution_name,
      academicYear: c.academic_year || null,
      marks: c.marks ? String(c.marks).trim() : null,
      issueDate: c.issue_date,
      certificateType: c.certificate_type,
      badge: chainVerified(c) ? 'Blockchain-verified' : `Record status: ${c.status}${c.blockchain_status && c.blockchain_status !== 'registered' ? ' · chain: ' + c.blockchain_status : ''}`,
      verificationUrl: qrService.verificationUrl(c.certificate_id),
    }));

    // Deterministic summary written ONLY from real facts above.
    const activeCerts = certs.filter((c) => c.status === 'ACTIVE');
    const verifiedCount = certs.filter(chainVerified).length;
    const degrees = [...new Set(activeCerts.map((c) => c.degree).filter(Boolean))];
    const institutions = [...new Set(activeCerts.map((c) => c.institution_name).filter(Boolean))];
    const latest = activeCerts[0] || certs[0];

    const parts = [];
    if (degrees.length) {
      parts.push(`Student with verified academic credentials in ${degrees.join(' and ')}${latest && latest.department ? ' (' + latest.department + ')' : ''} issued by ${institutions.join(' and ')}`);
    } else if (institutions.length) {
      parts.push(`Holds certificates issued by ${institutions.join(' and ')}`);
    }
    if (verifiedCount > 0) {
      parts.push(`${verifiedCount} of ${certs.length} certificate${certs.length === 1 ? '' : 's'} registered on-chain and independently verifiable through BlockCert AI`);
    }
    if (latest && latest.academic_year) {
      parts.push(`most recent credential for academic year ${latest.academic_year}`);
    }
    const deterministicSummary = parts.length ? parts.join('; ') + '.' : '';

    // Skill lists come from the questionnaire (personal input, honestly
    // labelled) merged with degree facts from certificates.
    const skills = {
      technical: answers.technicalSkills || [],
      tools: answers.tools || [],
      soft: answers.softSkills || [],
    };

    return res.json({
      success: true,
      data: {
        resume: {
          // Personal header: questionnaire first, account data as fallback.
          holderName: answers.fullName || user.name,
          email: answers.email || user.email,
          mobile: answers.mobile || null,
          cityState: answers.cityState || null,
          linkedinUrl: answers.linkedinUrl || null,
          portfolioUrl: answers.portfolioUrl || null,
          registrationNumber: user.registration_number || null,
          generatedAt: new Date().toISOString(),

          summary: deterministicSummary,

          // Self-reported education details + platform certificates.
          selfEducation: answers.collegeName || answers.degreeDept || answers.graduationYear || answers.cgpa || answers.currentYearSem || answers.school10 || answers.school12 || answers.coursework || null,
          selfEducationDetails: {
            collegeName: answers.collegeName || null,
            degreeDept: answers.degreeDept || null,
            currentYearSem: answers.currentYearSem || null,
            graduationYear: answers.graduationYear || null,
            cgpa: answers.cgpa || null,
            school10: answers.school10 || null,
            marks10: answers.marks10 || null,
            school12: answers.school12 || null,
            marks12: answers.marks12 || null,
            coursework: answers.coursework || null,
          },

          education,

          skills,
          projects: answers.projects || [],
          experience: answers.experience || [],
          hasExperience: Array.isArray(answers.experience) && answers.experience.length > 0,
          isFresher: Boolean(answers.isFresher) || !(Array.isArray(answers.experience) && answers.experience.length),
          certifications: answers.certifications || [],
          competitions: answers.competitions || [],
          achievements: answers.achievements || null,
          careerPreferences: answers.targetRole || answers.preferredIndustry || answers.roleType || answers.jobDescription || answers.resumeStyle ? {
            targetRole: answers.targetRole || null,
            preferredIndustry: answers.preferredIndustry || null,
            roleType: answers.roleType || null,
            jobDescription: answers.jobDescription || null,
            resumeStyle: answers.resumeStyle || null,
          } : null,

          sources: {
            certificatesIncluded: certs.length,
            questionnaireSections: Object.keys(answers),
            aiPolished: false,
            note: 'Contact, skills, projects, experience, certifications and preferences come from the student\'s own questionnaire answers. Certificate entries come from real records stored on this platform and are independently verifiable at each verification URL.',
          },
        },
        ai: { configured: aiService.isConfigured(), endpoint: '/api/ai/resume-summary' },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* ================= AI Resume Maker questionnaire =================
   Students self-report the resume content sections BEFORE the resume is
   built. Everything is optional except what the resume structurally needs;
   the experience section may be skipped entirely (freshers). Server-side
   whitelist + length caps: never trust the client with structure. */

const RESUME_TEXT_FIELDS = [
  // 1. Personal information
  ['fullName', 120], ['email', 160], ['mobile', 40], ['cityState', 120],
  ['linkedinUrl', 300], ['portfolioUrl', 300],
  // 2. Educational details (self-reported; platform certificates stay authoritative)
  ['collegeName', 200], ['degreeDept', 160], ['currentYearSem', 60],
  ['graduationYear', 20], ['cgpa', 40], ['school12', 200], ['marks12', 60],
  ['school10', 200], ['marks10', 60], ['coursework', 400],
  // 4-6. simple text sections
  ['achievements', 1200],
  // 7. Career preferences / AI tailoring
  ['targetRole', 120], ['preferredIndustry', 120], ['roleType', 40],
  ['jobDescription', 2000], ['resumeStyle', 40],
];

const RESUME_LIST_FIELDS = [
  ['technicalSkills', 40, 60],   // up to 40 skills, 60 chars each
  ['softSkills', 30, 60],
  ['tools', 40, 80],
  ['courseworkList', 30, 120],
];

const RESUME_PROJECT_FIELDS = [
  ['title', 160], ['description', 800], ['technologies', 240],
  ['role', 240], ['outcome', 400], ['link', 300],
];

const RESUME_EXPERIENCE_FIELDS = [
  ['organization', 200], ['jobTitle', 140], ['startDate', 40], ['endDate', 40],
  ['responsibilities', 800], ['achievements', 600],
];

const RESUME_CERT_FIELDS = [
  ['name', 200], ['issuer', 200], ['completionDate', 40], ['verificationUrl', 300],
];

const RESUME_COMPETITION_FIELDS = [
  ['name', 200], ['result', 200], ['date', 40],
];

function cleanText(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function cleanList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => cleanText(v, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** Whitelist + cap a questionnaire payload. Unknown keys are dropped. */
function sanitizeResumeAnswers(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  for (const [key, max] of RESUME_TEXT_FIELDS) {
    const v = cleanText(src[key], max);
    if (v) out[key] = v;
  }
  for (const [key, maxItems, maxLen] of RESUME_LIST_FIELDS) {
    const list = cleanList(src[key], maxItems, maxLen);
    if (list.length) out[key] = list;
  }

  if (Array.isArray(src.projects)) {
    out.projects = src.projects.slice(0, 8).map((p) => {
      const o = {};
      for (const [key, max] of RESUME_PROJECT_FIELDS) {
        const v = cleanText(p && p[key], max);
        if (v) o[key] = v;
      }
      return o;
    }).filter((p) => Object.keys(p).length);
  }

  if (Array.isArray(src.experience)) {
    out.experience = src.experience.slice(0, 6).map((e) => {
      const o = {};
      for (const [key, max] of RESUME_EXPERIENCE_FIELDS) {
        const v = cleanText(e && e[key], max);
        if (v) o[key] = v;
      }
      return o;
    }).filter((e) => Object.keys(e).length);
  }

  if (Array.isArray(src.certifications)) {
    out.certifications = src.certifications.slice(0, 12).map((c) => {
      const o = {};
      for (const [key, max] of RESUME_CERT_FIELDS) {
        const v = cleanText(c && c[key], max);
        if (v) o[key] = v;
      }
      return o;
    }).filter((c) => Object.keys(c).length);
  }

  if (Array.isArray(src.competitions)) {
    out.competitions = src.competitions.slice(0, 10).map((c) => {
      const o = {};
      for (const [key, max] of RESUME_COMPETITION_FIELDS) {
        const v = cleanText(c && c[key], max);
        if (v) o[key] = v;
      }
      return o;
    }).filter((c) => Object.keys(c).length);
  }

  out.isFresher = Boolean(src.isFresher);
  return out;
}

/** GET /api/students/me/resume-profile - saved questionnaire answers */
async function getResumeProfile(req, res, next) {
  try {
    const result = await query('SELECT answers, updated_at FROM student_resume_profiles WHERE student_id = $1', [req.user.id]);
    const row = result.rows[0];
    return res.json({ success: true, data: { answers: row ? row.answers : null, updatedAt: row ? row.updated_at : null } });
  } catch (err) {
    return next(err);
  }
}

/** PUT /api/students/me/resume-profile - save/replace questionnaire answers */
async function saveResumeProfile(req, res, next) {
  try {
    const answers = sanitizeResumeAnswers(req.body && req.body.answers);
    const saved = await query(
      `INSERT INTO student_resume_profiles (student_id, answers) VALUES ($1, $2)
       ON CONFLICT (student_id) DO UPDATE SET answers = $2, updated_at = NOW()
       RETURNING updated_at`,
      [req.user.id, JSON.stringify(answers)]
    );
    return res.json({ success: true, message: 'Resume details saved.', data: { answers, updatedAt: saved.rows[0].updated_at } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { myCertificates, myCredentials, publicProfile, myHistory, buildResume, getResumeProfile, saveResumeProfile };
