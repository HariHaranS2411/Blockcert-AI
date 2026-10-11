'use strict';

/**
 * On-chain interface definition for CertificateRegistry.sol.
 * The ABI mirrors contracts/CertificateRegistry.sol exactly.
 * (Deployment scripts compile the .sol file; the server only needs the ABI.)
 */

const CertificateRegistryABI = [
  'event CertificateIssued(bytes32 indexed recordId, string certificateId, bytes32 certificateHash, address indexed issuer, uint256 timestamp)',
  'event CertificateRevoked(bytes32 indexed recordId, string certificateId, address indexed issuer, uint256 timestamp)',
  'error RecordAlreadyExists(string certificateId)',
  'error RecordNotFound(string certificateId)',
  'error NotIssuer(address caller, address issuer)',
  'error EmptyCertificateId()',
  'error ZeroHash()',
  'function issueCertificate(string certificateId, bytes32 certificateHash)',
  'function verifyCertificate(string certificateId, bytes32 certificateHash) view returns (bool exists, bool hashMatch, bool revoked, address issuer, uint256 timestamp)',
  'function getCertificate(string certificateId) view returns (bytes32 certificateHash, address issuer, uint256 timestamp, bool revoked)',
  'function revokeCertificate(string certificateId)',
  'function isRevoked(string certificateId) view returns (bool)',
  'function getCertificateHash(string certificateId) view returns (bytes32)',
  'function getIssuer(string certificateId) view returns (address)',
  'function getTimestamp(string certificateId) view returns (uint256)',
];

module.exports = { CertificateRegistryABI };
