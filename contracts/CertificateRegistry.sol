// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * BlockCert AI - CertificateRegistry
 *
 * Stores ONLY the cryptographic fingerprint of a certificate document and the
 * minimum metadata required to make that record authoritative:
 *   - a deterministic reference derived from the certificate identifier
 *   - the SHA-256 hash of the document (bytes32)
 *   - the issuer (msg.sender) address
 *   - the registration timestamp
 *   - the revoked flag
 *
 * No personal data, PDFs, names, emails or document content is ever written
 * on-chain. Revocation never deletes the record; it only flips the flag.
 */
contract CertificateRegistry {
    struct CertificateRecord {
        bytes32 certificateHash;
        address issuer;
        uint256 timestamp;
        bool revoked;
    }

    // key = keccak256(bytes(certificateId))
    mapping(bytes32 => CertificateRecord) private records;

    event CertificateIssued(
        bytes32 indexed recordId,
        string certificateId,
        bytes32 certificateHash,
        address indexed issuer,
        uint256 timestamp
    );

    event CertificateRevoked(
        bytes32 indexed recordId,
        string certificateId,
        address indexed issuer,
        uint256 timestamp
    );

    error RecordAlreadyExists(string certificateId);
    error RecordNotFound(string certificateId);
    error NotIssuer(address caller, address issuer);
    error EmptyCertificateId();
    error ZeroHash();

    function _recordId(string calldata certificateId) internal pure returns (bytes32) {
        if (bytes(certificateId).length == 0) revert EmptyCertificateId();
        return keccak256(bytes(certificateId));
    }

    /// @notice Register a certificate fingerprint. Each certificate ID can be registered exactly once.
    function issueCertificate(string calldata certificateId, bytes32 certificateHash) external {
        if (certificateHash == bytes32(0)) revert ZeroHash();
        bytes32 recordId = _recordId(certificateId);
        if (records[recordId].timestamp != 0) revert RecordAlreadyExists(certificateId);

        records[recordId] = CertificateRecord({
            certificateHash: certificateHash,
            issuer: msg.sender,
            timestamp: block.timestamp,
            revoked: false
        });

        emit CertificateIssued(recordId, certificateId, certificateHash, msg.sender, block.timestamp);
    }

    /// @notice Read-only check: does a record exist and does it match the given hash?
    function verifyCertificate(string calldata certificateId, bytes32 certificateHash)
        external
        view
        returns (bool exists, bool hashMatch, bool revoked, address issuer, uint256 timestamp)
    {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        exists = record.timestamp != 0;
        hashMatch = exists && record.certificateHash == certificateHash;
        revoked = record.revoked;
        issuer = record.issuer;
        timestamp = record.timestamp;
    }

    function getCertificate(string calldata certificateId)
        external
        view
        returns (bytes32 certificateHash, address issuer, uint256 timestamp, bool revoked)
    {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        if (record.timestamp == 0) revert RecordNotFound(certificateId);
        return (record.certificateHash, record.issuer, record.timestamp, record.revoked);
    }

    /// @notice Only the issuing address may revoke its own certificate record.
    function revokeCertificate(string calldata certificateId) external {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        if (record.timestamp == 0) revert RecordNotFound(certificateId);
        if (record.issuer != msg.sender) revert NotIssuer(msg.sender, record.issuer);
        if (record.revoked) return;

        record.revoked = true;
        emit CertificateRevoked(recordId, certificateId, msg.sender, block.timestamp);
    }

    function isRevoked(string calldata certificateId) external view returns (bool) {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        if (record.timestamp == 0) revert RecordNotFound(certificateId);
        return record.revoked;
    }

    function getCertificateHash(string calldata certificateId) external view returns (bytes32) {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        if (record.timestamp == 0) revert RecordNotFound(certificateId);
        return record.certificateHash;
    }

    function getIssuer(string calldata certificateId) external view returns (address) {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        if (record.timestamp == 0) revert RecordNotFound(certificateId);
        return record.issuer;
    }

    function getTimestamp(string calldata certificateId) external view returns (uint256) {
        bytes32 recordId = _recordId(certificateId);
        CertificateRecord storage record = records[recordId];
        if (record.timestamp == 0) revert RecordNotFound(certificateId);
        return record.timestamp;
    }
}
