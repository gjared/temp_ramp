//
// temp_ramp.js
//
// Simple program to slowly lower temperature after
// first layer to avoid thermal undershoot on some
// machines
//
// Jared G
//

// Load modules
var fs = require('fs');
var split = require('split');
var Transform = require("stream").Transform;
var util = require("util");

// Check args
if (process.argv.length < 3) {
	console.log("Usage: temp_ramp.js <input.gcode>");
	process.exit();
}


// Stream processor
util.inherits(TempTransform, Transform);
function TempTransform(options) {
	Transform.call(this, options);

	// Main settings
	this.step = 3;
	this.steptime = 10;

	// Finished mode, passes through rest
	this.ramp_complete = false;

	// Temp tracking
	this.preamble = true;
	this.pretemp = null;
	this.temp = null;
	this.elapsed = 0.0;
	this.currstep = -1;
	this.currtemp = null;

	// Machine position and extruder state
	this.mstate = {
		X: 0.0,
		Y: 0.0,
		Z: 0.0,
		E: 0.0,
		F: 0.0
	};

	// Buffer output here, important for copy performance
	// in some scenarios, i.e. network drives
	this.bufcap = Math.pow(2, 16);
	this.outbuf = new Buffer(this.bufcap);
	this.obsize = 0;

}

// Helper to buffer output, or send null to flush
TempTransform.prototype.buffer_output = function(buf) {

	// See if there is enough room, if not, flush output first
	if (buf == null || (this.outbuf.length < this.obsize + buf.length + 2)) {
		this.push(this.outbuf.slice(0, this.obsize));

		// Can't reuse buffer immediately because still going through
		// output path.  For now just allocate new ones, can do something
		// smarter if needed.
		this.outbuf = new Buffer(this.bufcap);
		this.obsize = 0;
	}

	// Now copy it in
	if (buf != null) {		
		buf.copy(this.outbuf, this.obsize);
		this.outbuf.writeUInt8(13, this.obsize + buf.length);
		this.outbuf.writeUInt8(10, this.obsize + buf.length + 1);
		this.obsize += buf.length + 2;
	}
}


// Helper to iterate over args as arg type, val pairs
TempTransform.prototype.each_gcode_arg = function(parts, cb) {
	for (var i = 1; i < parts.length; i++) {
		var s = parts[i];
		cb(s.substr(0,1), s.substr(1));
	}
}


// Helper to extract matching arg
TempTransform.prototype.get_gcode_arg = function(parts, argname) {
	for (var i = 1; i < parts.length; i++) {
		var s = parts[i];
		if (s.substr(0, 1) == argname) return s.substr(1);		
	}
	return null;
}

// Helper ramp function, for now assumes we don't
// have such long motion intervals that we skip
// temporal steps
TempTransform.prototype.ramp_tick = function() {

	// Check if we're ready to start the ramp down
	if (this.temp == null) return;

	// Now quantize to check our step	
	var nstep = Math.floor(this.elapsed/this.steptime);
	//console.log(this.elapsed, nstep, this.currstep);
	if (nstep <= this.currstep) return;

	// See where the step takes us
	var target = this.currtemp - this.step;
	if (target < this.temp) target = this.temp;

	// Take a step now and continue on
	this.buffer_output(new Buffer("M104 S" + target + " T1", "ascii"));
	this.currtemp = target;		
	this.currstep = nstep;

	// Check if done
	if (this.currtemp == this.temp) {
		console.log("Thermal ramp complete!", this.currtemp, this.temp);
		this.ramp_complete = true;
	}
}


// Do fine-grained line processing
TempTransform.prototype.process_line = function(origline) {

	// Just copy straight if done
	if (this.ramp_complete) {
		this.buffer_output(origline);
		return;
	}

	// Trim off comments and end newline
	var line = origline;
	for (var i = 0; i < line.length; i++) {
		if (line[i] == 40 || line[i] == 59 || line[i] == 10) {
			line = line.slice(0, i);
			break;
		} 
	}

	// Extract first command here
	var parts = line.toString('ascii').split(" ");	

	// Now handle various cases here
	if (parts[0] == 'G1') {

		// Deltas here
		var deltas = {};

		// Compute deltas here while updating
		var self = this;
		this.each_gcode_arg(parts, function(arg, val) {

			var oldval = self.mstate[arg];
			var newval = parseFloat(val);
			deltas[arg] = newval - oldval;
			self.mstate[arg] = newval;

		});
		
		// Now compute motion delta
		var dsq = (deltas.X == null ? 0.0 : deltas.X * deltas.X) +
			(deltas.Y == null ? 0.0 : deltas.Y * deltas.Y) +
			(deltas.Z == null ? 0.0 : deltas.Z * deltas.Z);

		// Compute speed and time
		var dt = Math.sqrt(dsq) / (this.mstate.F / 60.0);		

		// Now check if we should increment elapsed
		if (this.temp != null) this.elapsed += dt;

	} else if (parts[0] == 'M104') {

		// Extract temp here
		var t = parseInt(this.get_gcode_arg(parts, "S"));

		// Temp setting, record as needed
		if (this.preamble) {

			// Store first layer temp
			if (this.pretemp == null) {
				this.pretemp = t;
				this.currtemp = t;
				console.log("First layer temp:", t);
			}

		} else {

			// Store temp and start ramp
			if (this.temp == null) {
				this.temp = t;
				console.log("Normal temp:", t);

				// Do a tick here and skip the copy out
				this.ramp_tick();				
				return;
			}
		}


	} else if (parts[0] == 'M108') {

		// Tool chance just helps us differentiate
		// M104s that come at start with the change
		// after first layer
		this.preamble = false;

	}

	// Log processed lines
	//console.log(parts);

	// Copy line here
	this.buffer_output(origline);

	// Do a ramp tick now
	this.ramp_tick();

}


// Main transform logic invoked on each line
TempTransform.prototype._transform = function (line, encoding, processed) {

	// Process each line here	
	this.process_line(line);
    processed();

}

// Flush last block at end
TempTransform.prototype._flush = function (cb) {

	this.process_line(null);
	cb();

}


// Open stream and outstream
var opts = { highWaterMark: Math.pow(2, 16) };
var istream = fs.createReadStream(process.argv[2], opts);
var ostream = fs.createWriteStream(process.argv[2] + ".tempmod", opts);

// Open infile and outfile
//istream.pipe(new TempTransform()).pipe(ostream);
var r = istream.pipe(split()).pipe(new TempTransform()).pipe(ostream);

// Bind a finisher to copy it back into place
r.on('finish', function(){
	console.log("Finished!");
	fs.renameSync(process.argv[2] + ".tempmod", process.argv[2]);
});
