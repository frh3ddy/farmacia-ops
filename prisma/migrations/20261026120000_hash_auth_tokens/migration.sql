-- Store session and device tokens as their SHA-256 (hex), never the token
-- itself. Clients keep the raw tokens and the api hashes what they send, so
-- existing devices and sessions keep working. Runs once: hashing twice would
-- lock everyone out.
UPDATE "Device"
SET "deviceToken" = encode(sha256(convert_to("deviceToken", 'UTF8')), 'hex');

UPDATE "EmployeeSession"
SET "deviceToken" = encode(sha256(convert_to("deviceToken", 'UTF8')), 'hex'),
    "sessionToken" = encode(sha256(convert_to("sessionToken", 'UTF8')), 'hex');
