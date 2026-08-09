const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  IMAGES_DIR,
  VIDEOS_DIR,
  MUSIC_DIR,
  VOICE_DIR,
  TEMP_DIR,
} = require("../config/constants");

async function ensureReelDirectories() {
  await Promise.all(
    [IMAGES_DIR, VIDEOS_DIR, MUSIC_DIR, VOICE_DIR, TEMP_DIR].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
}

function createJobId() {
  return randomUUID();
}

function getJobTempDir(jobId) {
  return path.join(TEMP_DIR, jobId);
}

async function createJobWorkspace(jobId) {
  const jobDir = getJobTempDir(jobId);
  await fs.mkdir(jobDir, { recursive: true });
  return jobDir;
}

async function saveVideoCopy(jobId, sourcePath) {
  const destination = path.join(VIDEOS_DIR, `${jobId}.mp4`);
  await fs.copyFile(sourcePath, destination);
  return destination;
}

async function cleanupJobWorkspace(jobId) {
  const jobDir = getJobTempDir(jobId);
  await fs.rm(jobDir, { recursive: true, force: true });
}

module.exports = {
  ensureReelDirectories,
  createJobId,
  createJobWorkspace,
  saveVideoCopy,
  cleanupJobWorkspace,
};
