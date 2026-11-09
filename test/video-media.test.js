import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });

test(
  'guarda el 3GP original y crea vistas a partir de su primer fotograma',
  { skip: ffmpegCheck.error ? 'FFmpeg no está instalado' : false },
  async () => {
    const originalCwd = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'nokia-video-test-'));
    let db;

    try {
      process.chdir(tempDir);
      process.env.DB_PATH = join(tempDir, 'test.sqlite');
      ({ default: db } = await import('../db/db.js'));
      const { processAndAttachVideo } = await import('../src/utils/media.js');

      const inputPath = join(tempDir, 'sample.3gp');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'color=c=red:s=176x144:d=1:r=10',
        '-c:v', 'h263',
        '-f', '3gp',
        inputPath,
      ]);
      const original = readFileSync(inputPath);
      const messageId = db.prepare(
        "INSERT INTO messages (text, from_me) VALUES ('[Video]', 1)"
      ).run().lastInsertRowid;

      const saved = await processAndAttachVideo(messageId, original, {
        mediaKey: 'video_test',
        filename: 'sample.3gp',
        mimeType: 'video/3gpp',
      });

      assert.equal(saved.previewError, null);
      assert.deepEqual(readFileSync(saved.fullPath), original);
      assert.equal(statSync(join(tempDir, 'public', 'media', 'view_video_test.jpg')).size > 0, true);
      assert.equal(statSync(join(tempDir, 'public', 'media', 'thumb_video_test.jpg')).size > 0, true);

      const attachment = db.prepare(
        'SELECT mime_type, file_name, file_size, file_path_full, file_path_view, file_path_thumb FROM attachments WHERE message_id = ?'
      ).get(messageId);
      assert.equal(attachment.mime_type, 'video/3gpp');
      assert.equal(attachment.file_name, 'sample.3gp');
      assert.equal(attachment.file_size, original.length);
      assert.equal(attachment.file_path_full, saved.fullRel);
      assert.ok(attachment.file_path_view);
      assert.ok(attachment.file_path_thumb);
    } finally {
      db?.close();
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
);
