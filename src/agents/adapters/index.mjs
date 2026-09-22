// Every agent with its own page, in tab order. Claude Code is not listed: it
// keeps its original page (report.html) and joins only the combined view.

import codex from './codex.mjs';
import { antigravityIde, antigravity, agy } from './antigravity.mjs';
import zcode from './zcode.mjs';
import { opencode, kilo } from './opencode.mjs';
import cline from './cline.mjs';
import copilot from './copilot.mjs';
import hermes from './hermes.mjs';
import lmstudio from './lmstudio.mjs';

export const ADAPTERS = [codex, antigravityIde, antigravity, agy, zcode, opencode, kilo, cline, copilot, hermes, lmstudio];
