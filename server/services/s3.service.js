const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

const BUCKET = process.env.S3_BUCKET_NAME;
const hasAwsCredentials = Boolean(
  BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
);

const UPLOADS_DIR = path.join(__dirname, "../uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Upload a file buffer to S3 (or local uploads directory if S3 is not configured).
 * @param {string} filePath - Path to file on disk
 * @param {string} originalName - Original filename
 * @param {string} mimetype - MIME type
 * @param {string} userId - Owner's user ID
 * @param {string} [folder='resumes'] - Folder prefix
 * @returns {Promise<{ key: string, url: string }>}
 */
exports.uploadToS3 = async (filePath, originalName, mimetype, userId, folder = "resumes") => {
  const ext = path.extname(originalName);
  const uniqueName = `${crypto.randomUUID()}${ext}`;
  const key = `${folder}/${userId}/${uniqueName}`;

  if (hasAwsCredentials) {
    const fileStream = fs.createReadStream(filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: fileStream,
        ContentType: mimetype,
      })
    );
    const url = `https://${BUCKET}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com/${key}`;
    return { key, url };
  }

  // Local disk fallback
  const targetFolder = path.join(UPLOADS_DIR, folder, userId);
  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder, { recursive: true });
  }
  const destPath = path.join(targetFolder, uniqueName);
  fs.copyFileSync(filePath, destPath);

  const baseUrl = process.env.VITE_BASE_URL || "http://localhost:5000";
  const url = `${baseUrl}/uploads/${folder}/${userId}/${uniqueName}`;
  return { key: `local://${folder}/${userId}/${uniqueName}`, url };
};

/**
 * Delete a file from S3 (or local uploads directory) by its key.
 * @param {string} key - The object key to delete
 */
exports.deleteFromS3 = async (key) => {
  if (!key) return;

  if (hasAwsCredentials && !key.startsWith("local://")) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );
    return;
  }

  const localRelative = key.replace("local://", "");
  const localPath = path.join(UPLOADS_DIR, localRelative);
  if (fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
  }
};

/**
 * Generate a pre-signed URL for an S3 object (or local URL if local fallback).
 * @param {string} key - The object key
 * @param {number} expiresIn - Expiry time in seconds
 * @returns {Promise<string>}
 */
exports.getPresignedUrl = async (key, expiresIn = 3600) => {
  if (!key) return null;

  if (hasAwsCredentials && !key.startsWith("local://")) {
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });
    return await getSignedUrl(s3, command, { expiresIn });
  }

  const localRelative = key.replace("local://", "");
  const baseUrl = process.env.VITE_BASE_URL || "http://localhost:5000";
  return `${baseUrl}/uploads/${localRelative}`;
};
