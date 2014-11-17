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
var lineReader = require('line-reader');

// Check args
if (process.argv.length < 3) {
	console.log("Usage: temp_ramp.js <input.gcode>");
	process.exit();
}

// Rate to drop temperature
var step = 3;
var steptime = 10;

// Now open and walk file
var preamble = true;
var pretemp = null;
var temp = null;
var elapsed = 0.0;
var currstep = 0;
var currtemp = null;

// Stateful stuff
var x = 0.0, y = 0.0, z = 0.0, e = 0.0, f = 600.0;

// Output stuff, synchronous
var ofd = fs.openSync(process.argv[2] + ".tempmod", "w");

// Helper function to write
var output = function(str) {
	var buf = new Buffer(str);
	fs.writeSync(ofd, buf, 0, buf.length);
}

// Process
lineReader.eachLine(process.argv[2], function(line, last) {

	// Capture temp lines and specially handle here
	if (m = line.match(/^M104 (T\d )?S(\d+)/)) {

		// Check here
		if (preamble) {
			if (pretemp == null) pretemp = parseInt(m[2]);
			if (currtemp == null) currtemp = pretemp;
		} else {
			if (temp == null) {
				temp = parseInt(m[2]);

				// Step down if we need to
				if (currtemp - step > temp) {
					currtemp -= step;	
				} else {
					currtemp = temp;
				}				

				// Special case, take first step down and
				// do not copy the temp here
				output("M104 S" + currtemp + " T1\n");
				return;

			}
		}

	}

	// Copy over line here	
	output(line + "\n");

	// Capture move lines 
	if (m = line.match(/^G1( X[^\s]+)?( Y[^\s]+)?( Z[^\s]+)?( E[^\s]+)?( F[^\s]+)?/)) {

		// Parse as data here
		var nx, ny, nz, ne, nf;
		nx = m[1] != null ? parseFloat(m[1].substr(2)) : x;
		ny = m[2] != null ? parseFloat(m[2].substr(2)) : y;
		nz = m[3] != null ? parseFloat(m[3].substr(2)) : z;
		ne = m[4] != null ? parseFloat(m[4].substr(2)) : e;
		nf = m[5] != null ? parseFloat(m[5].substr(2)) : f;

		// Compute move distance
		var dx = nx - x, dy = ny - y, dz = nz - z;
		var delta = Math.sqrt(dx * dx + dy * dy + dz * dz);

		// Compute move time in seconds
		var dt = delta / (nf / 60.0);

		// Start counting and ticking here once we have a valid
		// target temp
		if (temp != null && currtemp != temp) {

			// Increase time
			elapsed += dt;

			// Check quantizing, take a temp step if needed
			var sidx = Math.floor(elapsed/steptime);
			if (sidx > currstep) {

				// Take the step
				if (currtemp - step > temp) {
					currtemp -= step;	
				} else {
					currtemp = temp;
				}		

				// Increment here
				currstep = sidx;

				// Output the string
				output("M104 S" + currtemp + " T1\n");
			}

			
		}

		// Update pos now
		x = nx;
		y = ny;
		z = nz;
		e = ne;
		f = nf;		
	}

	// Look for start of print
	if (line.match(/^M108/)) {
		preamble = false;		
	}

	// All done
	if (last) {
		console.log("Finished!");
		fs.closeSync(ofd);

		// Now overwrite the file!
		fs.renameSync(process.argv[2] + ".tempmod", process.argv[2]);
	}

});


