// /api/intent.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { message = '' } = req.body || {};
  const text = String(message || '').trim();

  // QUICK RULES (fast path). We can add an LLM fallback later.
  // searchDrive: "check in the <folder> folder and find <query>"
  const mDrive = text.match(/check in (?:the )?(?<folder>.+?) folder (?:and )?find (?<query>.+)/i);

  // searchSheets: "from <file> sheet <sheet> read <range> [where <criteria>]"
  const mSheets = text.match(/from (?<file>.+?) sheet (?<sheet>.+?) read (?<range>[A-Z]+\d*:[A-Z]+\d*|\w+)(?: where (?<criteria>.+))?/i);

  // adjustSheets: "in <file> sheet <sheet> set <range> to <values>" or "append row ..."
  const mAdjustSheetsSet = text.match(/in (?<file>.+?) sheet (?<sheet>.+?) set (?<range>[A-Z]+\d*:[A-Z]+\d*) to (?<values>.+)/i);
  const mAdjustSheetsAppend = text.match(/in (?<file>.+?) sheet (?<sheet>.+?) append (?:row|rows?) (?<values>.+)/i);

  // adjustCalendar: "create a calendar event ..." or "move ... to ..."
  const mCalCreate = text.match(/(?:create|add)(?: a)? calendar event (?<title>.+?) (?:on|for) (?<when>.+)/i);
  const mCalMove   = text.match(/(?:move|reschedule).+?calendar.*?(?<title>.+?) to (?<when>.+)/i);

  // searchWeb: "search: <query>" or "web: <query>" or "google <query>"
  const mWeb = text.match(/^(?:\s*search:|\s*web:|google\s+)(?<q>.+)/i);

  let intent = 'unknown';
  let params = {};

  if (mDrive) {
    intent = 'searchDrive';
    params = { folder: mDrive.groups.folder.trim(), query: mDrive.groups.query.trim(), fileTypes: [] };
  } else if (mSheets) {
    intent = 'searchSheets';
    params = {
      fileName: mSheets.groups.file.trim(),
      sheetName: mSheets.groups.sheet.trim(),
      range: mSheets.groups.range.trim(),
      query: (mSheets.groups.criteria || '').trim()
    };
  } else if (mAdjustSheetsSet || mAdjustSheetsAppend) {
    intent = 'adjustSheets';
    params = mAdjustSheetsSet ? {
      fileName: mAdjustSheetsSet.groups.file.trim(),
      sheetName: mAdjustSheetsSet.groups.sheet.trim(),
      range: mAdjustSheetsSet.groups.range.trim(),
      op: 'set',
      values: mAdjustSheetsSet.groups.values.trim()
    } : {
      fileName: mAdjustSheetsAppend.groups.file.trim(),
      sheetName: mAdjustSheetsAppend.groups.sheet.trim(),
      op: 'append',
      values: mAdjustSheetsAppend.groups.values.trim()
    };
  } else if (mCalCreate || mCalMove) {
    intent = 'adjustCalendar';
    params = mCalCreate ? {
      action: 'create',
      title: mCalCreate.groups.title.trim(),
      when: mCalCreate.groups.when.trim()
    } : {
      action: 'move',
      title: mCalMove.groups.title.trim(),
      when: mCalMove.groups.when.trim()
    };
  } else if (mWeb) {
    intent = 'searchWeb';
    params = { query: mWeb.groups.q.trim(), topK: 5 };
  }

  // Echo back structured result (LLM fallback can be added later)
  return res.status(200).json({
    intent,
    params,
    confidence: intent === 'unknown' ? 0.3 : 0.9
  });
}
