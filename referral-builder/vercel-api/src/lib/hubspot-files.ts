/**
 * Upload the generated memo .docx to HubSpot Files and attach it to the deal.
 *
 * We use the raw Files v3 + CRM v3 HTTP endpoints (with the private-app token)
 * rather than the generated client's positional `filesApi.upload` signature,
 * which drifts between SDK versions and is awkward with Buffers.
 *
 * Requires the `files` scope on the HubSpot private app (in addition to the
 * deal scopes the app already holds).
 */

import { config } from './config';

const HUBSPOT_API = 'https://api.hubapi.com';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// HUBSPOT_DEFINED association type id for Note → Deal.
const NOTE_TO_DEAL_TYPE_ID = 214;

export interface UploadedMemo {
  fileId: string;
  url: string | null;
  noteId: string | null;
}

function authHeader(): Record<string, string> {
  // Prefer a dedicated files-scoped token (HUBSPOT_FILES_TOKEN) so the main
  // access token never needs the `files` scope added. Fall back to it.
  const token = config.hubspot.filesToken || config.hubspot.accessToken;
  if (!token) {
    throw new Error(
      'No HubSpot token for Files upload (set HUBSPOT_FILES_TOKEN or HUBSPOT_ACCESS_TOKEN).'
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Upload a .docx buffer to HubSpot Files. Returns the file id and a public
 * (non-indexable) URL suitable for sharing with a client.
 */
export async function uploadDocxToHubspot(
  buffer: Buffer,
  fileName: string,
  folderPath: string
): Promise<{ fileId: string; url: string | null }> {
  const form = new FormData();
  // Wrap in a fresh Uint8Array so the Blob part is backed by a plain
  // ArrayBuffer (Node's Buffer types as ArrayBufferLike, which TS rejects).
  form.append('file', new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }), fileName);
  form.append('folderPath', folderPath);
  form.append(
    'options',
    JSON.stringify({
      access: 'PUBLIC_NOT_INDEXABLE',
      overwrite: false,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'EXACT_FOLDER',
    })
  );

  const res = await fetch(`${HUBSPOT_API}/files/v3/files`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.message ||
      data?.errors?.[0]?.message ||
      `HubSpot Files upload failed (${res.status})`;
    throw new Error(msg);
  }
  return { fileId: String(data.id), url: data.url ?? null };
}

/**
 * Create a Note on the deal with the uploaded file attached, so the memo shows
 * up under the deal's attachments/activity. Best-effort: if the note fails the
 * upload still succeeded, so callers can surface the file URL regardless.
 */
export async function attachFileToDeal(
  dealId: string,
  fileId: string,
  noteBody: string
): Promise<string | null> {
  const body = {
    properties: {
      hs_timestamp: String(Date.now()),
      hs_note_body: noteBody,
      hs_attachment_ids: fileId,
    },
    associations: [
      {
        to: { id: dealId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: NOTE_TO_DEAL_TYPE_ID,
          },
        ],
      },
    ],
  };

  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Don't fail the whole flow on the note; the file is already uploaded.
    console.error(
      `[memo] failed to attach note to deal ${dealId}:`,
      data?.message || res.status
    );
    return null;
  }
  return data?.id ? String(data.id) : null;
}

/**
 * Upload + attach in one call. The note attachment is best-effort.
 */
export async function deliverMemoToDeal(
  dealId: string,
  buffer: Buffer,
  fileName: string,
  noteBody: string
): Promise<UploadedMemo> {
  const { fileId, url } = await uploadDocxToHubspot(
    buffer,
    fileName,
    config.memo.filesFolderPath
  );
  const noteId = await attachFileToDeal(dealId, fileId, noteBody);
  return { fileId, url, noteId };
}
