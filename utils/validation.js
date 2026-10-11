'use strict';

const { body, param, query, validationResult } = require('express-validator');

const CERTIFICATE_TYPES = [
  'Degree',
  'Diploma',
  'Internship',
  'Course',
  'Workshop',
  'Hackathon',
  'Sports',
  'NSS/NCC',
  'Training',
  'Skill',
  'Academic Transcript',
];

const ROLES = ['STUDENT', 'INSTITUTION', 'EMPLOYER', 'ADMIN'];

/** Collects validation errors into the standard error envelope. */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const first = errors.array()[0];
  return res.status(400).json({
    success: false,
    message: first.msg,
    field: first.path,
  });
}

const registerRules = [
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Name must be between 2 and 120 characters.').matches(/^[^<>]+$/).withMessage('Name contains invalid characters.'),
  body('email').trim().isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('password')
    .isLength({ min: 8, max: 128 })
    .withMessage('Password must be at least 8 characters.')
    .matches(/[A-Za-z]/)
    .withMessage('Password must contain a letter.')
    .matches(/[0-9]/)
    .withMessage('Password must contain a digit.'),
  body('role').isIn(ROLES).withMessage('A valid role is required.'),
  body('institutionName')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage('Institution name must be between 2 and 200 characters.'),
  body('registrationNumber')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Registration number must be at most 100 characters.'),
  body('website').optional({ nullable: true }).trim().isLength({ max: 300 }).isURL({ require_tld: false })
    .withMessage('Website must be a valid URL.'),
  body('address').optional({ nullable: true }).trim().isLength({ max: 500 }),
];

const loginRules = [
  body('email').trim().isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('password').isLength({ min: 1 }).withMessage('Password is required.'),
];

const issueCertificateRules = [
  body('studentName').trim().isLength({ min: 2, max: 120 }).withMessage('Student name must be between 2 and 120 characters.'),
  body('registrationNumber').trim().isLength({ min: 1, max: 60 }).withMessage('Register number is required.'),
  body('degree').trim().isLength({ min: 2, max: 160 }).withMessage('Degree/programme must be between 2 and 160 characters.'),
  body('department').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('certificateType').isIn(CERTIFICATE_TYPES).withMessage('A valid certificate type is required.'),
  body('issueDate').isISO8601().withMessage('Issue date must be YYYY-MM-DD.').toDate(),
  body('expiryDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Expiry date must be YYYY-MM-DD.').toDate(),
  body('academicYear').optional({ nullable: true }).trim().isLength({ max: 40 }),
  body('semester')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isInt({ min: 1, max: 10 })
    .withMessage('Semester must be a number between 1 and 10.')
    .toInt(),
  body('marks').optional({ nullable: true }).trim().isLength({ max: 60 }),
  body('studentEmail')
    .trim()
    .isEmail()
    .withMessage('Student login email is required and must be a valid email address.')
    .normalizeEmail(),
  body('studentPassword')
    .isLength({ min: 8, max: 128 })
    .withMessage('Student login password is required and must be at least 8 characters.')
    .matches(/[A-Za-z]/)
    .withMessage('Student password must contain a letter.')
    .matches(/[0-9]/)
    .withMessage('Student password must contain a digit.'),
];

const revokeRules = [
  param('id').isInt({ min: 1 }).withMessage('A valid certificate id is required.'),
  body('reason').trim().isLength({ min: 5, max: 500 }).withMessage('A revocation reason of at least 5 characters is required.'),
];

const idParamRule = param('id').isInt({ min: 1 }).withMessage('A valid id is required.');

const certificateIdRule = body('certificateId')
  .trim()
  .matches(/^CERT-\d{4}-\d{6}$/)
  .withMessage('Certificate ID must use the format CERT-YYYY-XXXXXX.');

const searchRules = [
  query('q').optional({ nullable: true }).trim().isLength({ max: 120 }),
  query('status').optional({ nullable: true }).isIn(['ACTIVE', 'REVOKED', 'SUSPENDED']),
  query('type').optional({ nullable: true }).isIn(CERTIFICATE_TYPES),
  query('page').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
  query('limit').optional({ nullable: true }).isInt({ min: 1, max: 100 }).toInt(),
];

const institutionRules = [
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Institution name must be between 2 and 200 characters.'),
  body('registrationNumber').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('officialEmail').trim().isEmail().withMessage('A valid official email is required.').normalizeEmail(),
  body('address').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('website').optional({ nullable: true, checkFalsy: true }).trim().isURL({ require_tld: false }).withMessage('Website must be a valid URL.'),
  body('walletAddress').optional({ nullable: true, checkFalsy: true }).trim().matches(/^0x[a-fA-F0-9]{40}$/).withMessage('Wallet address must be a 0x-prefixed 40-hex-character address.'),
];

module.exports = {
  CERTIFICATE_TYPES,
  ROLES,
  validate,
  registerRules,
  loginRules,
  issueCertificateRules,
  revokeRules,
  idParamRule,
  certificateIdRule,
  searchRules,
  institutionRules,
};
