/**
 * MockFlow Bridge - daily generation cap (basic plan).
 *
 * Basic (free) plan gets a fixed number of live generations per day through the
 * bridge; past that the render_* tools are refused with an upgrade nudge until
 * the next local day. Only draws that target a basic board count (mcpEndpoint
 * checks hub.isTargetBasic first) - a Pro user is never metered.
 *
 * A "generation" is one component/board actually drawn onto the board. Reads,
 * layout, modify-in-place and connector calls are free; a plan_board batch is
 * counted as its individual render_* draws (each comes back through the endpoint
 * on its own), so a plan of 12 items spends 12, not 1.
 *
 * This is a LOCAL, bridge-side meter: it lives on the user's machine and is
 * deliberately not bypass-proof. It preserves the upgrade trigger for ordinary
 * use; revenue-grade enforcement belongs server-side alongside the AI-credit
 * meter, not here.
 *
 * State is a tiny JSON file: { date: 'YYYY-MM-DD', count: N }. A day change
 * (local time) resets the count on the next read.
 */

const fs = require('fs');
const config = require('./config');

class GenerationCap {
	constructor(opts) {
		this.log = (opts && opts.log) || function() {};
		this.limit = (opts && opts.limit) || config.BASIC_DAILY_GEN_CAP;
		this.file = (opts && opts.file) || config.GEN_CAP_FILE;
		this.state = this._load();
	}

	/** Local calendar day as YYYY-MM-DD (the reset boundary). */
	_today() {
		const d = new Date();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return d.getFullYear() + '-' + m + '-' + day;
	}

	_load() {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (data && typeof data.date === 'string' && typeof data.count === 'number') {
				return { date: data.date, count: data.count };
			}
		} catch (e) {}
		return { date: this._today(), count: 0 };
	}

	_save() {
		try {
			fs.mkdirSync(config.HOME_DIR, { recursive: true });
			fs.writeFileSync(this.file, JSON.stringify(this.state));
		} catch (e) {
			this.log('Could not persist generation count:', e && e.message);
		}
	}

	/** Roll the counter over when the local day changed. */
	_rollIfNeeded() {
		const today = this._today();
		if (this.state.date !== today) {
			this.state = { date: today, count: 0 };
			this._save();
		}
	}

	/** How many generations remain today. */
	remaining() {
		this._rollIfNeeded();
		return Math.max(0, this.limit - this.state.count);
	}

	/** True while there is at least one generation left today. */
	allowed() {
		return this.remaining() > 0;
	}

	/** Count one generation (called only after a draw actually landed). */
	record() {
		this._rollIfNeeded();
		this.state.count++;
		this._save();
		return this.state.count;
	}
}

module.exports = GenerationCap;
