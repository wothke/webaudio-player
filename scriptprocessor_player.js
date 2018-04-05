/**
* Generic ScriptProcessor based WebAudio player. 
*
* This infrastructure consists of two parts:
*
* <p>SamplePlayer: The generic player which must be parameterized with a specific AudioBackendAdapterBase 
*                  subclass (which is not contained in this lib)
*
* <p>AudioBackendAdapterBase: an abstract base class for specific backend (i.e. 'sample data producer') integration.
*
*	version 1.03a (with WASM support, cached filename translation & track switch bugfix, "internal filename" 
				mapping, getVolume, setPanning)
*
* 	Copyright (C) 2018 Juergen Wothke
*
* Terms of Use: This software is licensed under a CC BY-NC-SA 
* (http://creativecommons.org/licenses/by-nc-sa/4.0/).
*/

var fetchSamples= function (e) {
	// it seems that it is necessary to keep this explicit reference to the event-handler
	// in order to pervent the dumbshit Chrome GC from detroying it eventually
	
	var f= window.player['genSamples'].bind(window.player); // need to re-bind the instance.. after all this 
															// joke language has no real concept of OO	
	f(e);
};

var calcTick= function (e) {
	var f= window.player['tick'].bind(window.player);
	f(e);
};

var setGlobalWebAudioCtx= function() {
	if (typeof window._gPlayerAudioCtx == 'undefined') {	// cannot be instantiated 2x (so make it global)
		
		var errText= 'Web Audio API is not supported in this browser';
		try {			
			if('AudioContext' in window) {
				window._gPlayerAudioCtx = new AudioContext();
			} else if('webkitAudioContext' in window) {
				window._gPlayerAudioCtx = new webkitAudioContext();		// legacy stuff
			} else {
				alert(errText + e);
			}
		} catch(e) {
			alert(errText + e);
		}
	}		
}

/* 
	Poor man's JavaScript inheritance: 'extend' must be used to subclass AudioBackendAdapterBase to create backend specific adapters.

	usage:

	SomeBackendAdapter = (function(){ var $this = function () { $this.base.call(this, channels, bytesPerSample);}; 
		extend(AudioBackendAdapterBase, $this, {  
			getAudioBuffer: function() {
				...	
			},
			getAudioBufferLength: function() {
				...
			},
			...
		});	return $this; })();
*/
function surrogateCtor() {}
function extend(base, sub, methods) {
  surrogateCtor.prototype = base.prototype;
  sub.prototype = new surrogateCtor();
  sub.prototype.constructor = sub;
  sub.base = base;
  for (var name in methods) {
    sub.prototype[name] = methods[name];
  }
  return sub;
}

/*
* Subclass this class in order to sync/associate stuff with the audio playback. 
* 
* If a respective subclass is specified upon instanciation of the ScriptNodePlayer, then the player will track 
* playback progress as 'ticks' (one 'tick' typically measuring 256 audio samples). "Ticks" are measured within the
* context of the current playback buffer and whenever a new buffer is played the counting restarts from 0.
*
* During playback (e.g. from some "animation frame" handler) the current playback position can be queried using 
* ScriptNodePlayer.getInstance().getCurrentTick().
*
* The idea is for the AbstractTicker to provide additional "tick resolution" data that can be queried using the 
* "current tick". During playback the original audio buffers are fed to the AbstractTicker before they are played 
* (see 'calcTickData'). This allows the AbstractTicker to build/update its "tick resolution" data.
*/
AbstractTicker = function() {}
AbstractTicker.prototype = {
	/*
	* Constructor that allows the AbstractTicker to setup its own data structures (the 
	* number of 'tick' events associated with each sample buffer is: samplesPerBuffer/tickerStepWidth).
	* @samplesPerBuffer number of audio samples in the original playback buffers - that the AbstractTicker can use to 
	*                   derive its additional data streams from
	* @tickerStepWidth  number of audio samples that are played between "tick events"
	*/
	init: function(samplesPerBuffer, tickerStepWidth) {},
	/*
	* Invoked with each audio buffer before it is played.
	*/
	calcTickData: function(output1, output2) {},
	
	/*
	* Gets called each time the computeAudioSamples() has been invoked.
	*/
	computeAudioSamplesNotify: function() {}
};


var SAMPLES_PER_BUFFER = 8192;// allowed: buffer sizes: 256, 512, 1024, 2048, 4096, 8192, 16384

		
/*
* Abstract 'audio backend adapter'.
*
* Not for "end users"! Base infrastructure for the integration of new backends:
*
* Must be subclassed for the integration of a specific backend: It adapts the APIs provided by a 
* specific backend to the ones required by the player (e.g. access to raw sample data.) It 
* provides hooks that can be used to pass loaded files to the backend. The adapter also has 
* built-in resampling logic so that exactly the sampleRate required by the player is provided).
*
* Most backends are pretty straight forward: A music file is input and the backend plays it. Things are
* more complicated if the backend code relies on additional files - maybe depending on the input -
* that must be loaded in order to play the music. The problem arises because in the traditional runtime
* environment files are handled synchronously: the code waits until the file is loaded and then uses it.
*
* "Unfortunately" there is no blocking file-load available to JavaScript on a web page. So unless some 
* virtual filesystem is built-up beforehand (containing every file that the backend could possibly ever 
* try to load) the backend code is stuck with an asynchronous file loading scheme, and the original 
* backend code must be changed to a model that deals with browser's "file is not yet ready" response. 
*
* The player offers a trial & error approach to deal with asynchronous file-loading. The backend code
* is expected (i.e. it must be adapted accordingly) to attempt a file-load call (which is handled by 
* an async web request linked to some sort of result cache). If the requested data isn't cached yet, 
* then the backend code is expected to fail but return a corresponding error status back to the 
* player (i.e. the player then knows that the code failed because some file wasn't available yet - and 
* as soon as the file-load is completed it retries the whole initialization sequence).
*  (see "fileRequestCallback()" for more info)
*/
AudioBackendAdapterBase = function (channels, bytesPerSample) {
	this._resampleBuffer=  new Float32Array();
	this._channels= channels;
	this._bytesPerSample= bytesPerSample;
	this._sampleRate= 44100;
	this._inputSampleRate= 44100;
	this._observer;
	this._manualSetupComplete= true;	// override if necessary
};

AudioBackendAdapterBase.prototype = {

// ************* core functions that must be defined by a subclass

	/**
	* Fills the audio buffer with the next batch of samples
	* Return 0: OK, -1: temp issue - waiting for file, 1: end, 2: error 
	*/
	computeAudioSamples: function() 			{this.error("computeAudioSamples");},
	
	/**
	* Load the song's binary data into the backend as a first step towards playback.
	* The subclass can either use the 'data' directly or us the 'filename' to retrieve it indirectly 
	* (e.g. when regular file I/O APIs are used).
	*/
	loadMusicData: function(sampleRate, path, filename, data, options) {this.error("loadMusicData");},
	
	/**
	* Second step towards playback: Select specific sub-song from the loaded song file.
	* Allows to select a specific sub-song and/or apply additional song setting..
	*/
	evalTrackOptions: function(options)  {this.error("evalTrackOptions");},
		
	/**
	* Get info about currently selected music file and track. Respective info very much depends on 
	* the specific backend - use getSongInfoMeta() to check for available attributes. 
	*/
	updateSongInfo: function(filename, result) {this.error("updateSongInfo");},
	
	/**
	* Advertises the song attributes that can be provided by this backend.
	*/
	getSongInfoMeta: function() {this.error("getSongInfoMeta");},

	
// ************* sample buffer and format related

	/** 
	* Return: pointer to memory buffer that contains the sample data
	*/
	getAudioBuffer: function() 					{this.error("getAudioBuffer");},
	
	/**
	* Return: length of the audio buffer in 'ticks' (e.g. mono buffer with 1 8-bit 
	*         sample= 1; stereo buffer with 1 32-bit * sample for each channel also= 1)
	*/
	getAudioBufferLength: function() 			{this.error("getAudioBufferLength");},

	/**
	* Reads one audio sample from the specified position.
	* Return sample value in range: -1..1 
	*/
	readFloatSample: function(buffer, idx) 		{this.error("readFloatSample");},

	/**
	* Return size one sample in bytes
	*/
	getBytesPerSample: function() {
		return this._bytesPerSample;
	},
	
	/**
	* Number of channels, i.e. 1= mono, 2= stereo
	*/
	getChannels: function() {
		return this._channels;
	},
	
// ************* optional: setup related
	/*
	* Implement if subclass needs additional setup logic.
	*/
	isAdapterReady: function() {
		return true;
	},		

	/*
	* Creates the URL used to retrieve the song file.
	*/
	mapInternalFilename: function(overridePath, defaultPath, uri) {
		return ((overridePath)?overridePath:defaultPath) + uri;	// this._basePath ever needed?
	},
	/*
	* Allows to map the filenames used in the emulation to external URLs.
	*/
	mapUrl: function(filename) {
		return filename;
	},
	
	/*
	* Allows to perform some file input based manual setup sequence (e.g. setting some BIOS).
	* return 0: step successful & init completed, -1: error, 1: step successful
	*/
	uploadFile: function(filename, options) {
		return 0;
	},
	
	/*
	* Check if this AudioBackendAdapterBase still needs manually performed 
	* setup steps (see uploadFile())
	*/
	isManualSetupComplete: function() {
		return this._manualSetupComplete;
	},	
	
	/**
	* Cleanup backend before playing next music file
	*/
	teardown: function()		 	{this.error("teardown");},

// ************* optional: song "position seek" functionality (only available in backend)
	
	/** 
	* Return: default 0 = seeking not supported 
	*/
	getMaxPlaybackPosition: function() 				{ return 0;},
	
	/** 
	* Return: default 0 
	*/
	getPlaybackPosition: function() 				{ return 0;},
	
	/** 
	* Move playback to 'pos': must be between 0 and getMaxPlaybackPosition()
	* Return: 0 if successful
	*/
	seekPlaybackPosition: function(pos) 				{ return -1;},
	
// ************* optional: async file-loading related (only if needed)

	/**
	* Transform input filename into path/filename expected by the backend
	* Return array with 2 elements: 0: basePath (backend specific - most don't need one), 
	*        1: filename (incl. the remainder of the path)
	*/
	getPathAndFilename: function(filename) {this.error("getPathAndFilename");},
	
	/**
	* Let backend store a loaded file in such a way that it can later deal with it.
	* Return a filehandle meaningful to the used backend
	*/
	registerFileData: function(pathFilenameArray, data)	{this.error("registerFileData");},
	
	// if filename/path used by backend does not match the one used by the browser
	mapBackendFilename: function(name) { return name;},
	
	// introduced for backward-compatibility..
	mapCacheFileName: function(name) { return name;},
	/*
	* Backend may "push" update of song attributes (like author, copyright, etc)
	*/ 
	handleBackendSongAttributes: function(backendAttr, target) {this.error("handleBackendSongAttributes");},	
	
	
// ************* built-in utility functions
	mapUri2Fs: function(uri) {		// use extended ASCII that most likely isn't used in filenames
		// replace chars that cannot be used in file/foldernames
		var out= uri.replace(/\/\//, "ýý");	
			out = out.replace(/\?/, "ÿ");
			out = out.replace(/:/, "þ");
			out = out.replace(/\*/, "ü");
			out = out.replace(/"/, "û");
			out = out.replace(/</, "ù");
			out = out.replace(/>/, "ø");
			out = out.replace(/\|/, "÷");
		return out;
	},
	mapFs2Uri: function(fs) {
		var out= fs.replace(/ýý/, "//");
			out = out.replace(/ÿ/, "?");
			out = out.replace(/þ/, ":");
			out = out.replace(/ü/, "*");
			out = out.replace(/û/, "\"");
			out = out.replace(/ù/, "<");
			out = out.replace(/ø/, ">");
			out = out.replace(/÷/, "|");
		return out;
	},

	// used for interaction with player
	setObserver: function(o) {
		this._observer= o;
	},
	notifyAdapterReady: function() {
		if (typeof this._observer !== "undefined" )	this._observer.notify();	
	},
	error: function(name) {
		alert("fatal error: abstract method '"+name+"' must be defined");	
	},
	resetSampleRate: function(sampleRate, inputSampleRate) {
		// FIXME todo: _currentTimeout must also be reset! 
		if (sampleRate > 0) { this._sampleRate= sampleRate; }
		if (inputSampleRate > 0) { this._inputSampleRate= inputSampleRate; }
		
		var s= Math.round(SAMPLES_PER_BUFFER *this._sampleRate/this._inputSampleRate) *this.getChannels();
	
		if (s > this._resampleBuffer.length) {
			this._resampleBuffer= this.allocResampleBuffer(s);
		}
	},
	allocResampleBuffer: function(s) {
		return new Float32Array(s);
	},
	getCopiedAudio: function(buffer, len) {
		var i;
		// just copy the rescaled values so there is no need for special handling in playback loop
		for(i= 0; i<len*this._channels; i++){
			this._resampleBuffer[i]= this.readFloatSample(buffer, i); 
		}		
		return len;	
	},
	getResampledAudio: function(buffer, len) {	
		var resampleLen;
		if (this._sampleRate == this._inputSampleRate) {		
			resampleLen= this.getCopiedAudio(buffer, len);
		} else {
			resampleLen= Math.round(len * this._sampleRate / this._inputSampleRate);	
			var bufSize= resampleLen * this._channels;	// for each of the x channels
			
			if (bufSize > this._resampleBuffer.length) { this._resampleBuffer= this.allocResampleBuffer(bufSize); }
			
			// only mono and interleaved stereo data is currently implemented..
			this.resampleChannel(0, buffer, len, resampleLen);
			if (this._channels == 2) {
				this.resampleChannel(1, buffer, len, resampleLen);
			}
		}
		return resampleLen;
	},
	resampleChannel: function(channelId, buffer, len, resampleLen) {
		// Bresenham algorithm based resampling
		var x0= 0;
		var y0= 0;
		var x1= resampleLen - 0;
		var y1= len - 0;

		var dx =  Math.abs(x1-x0), sx = x0<x1 ? 1 : -1;
		var dy = -Math.abs(y1-y0), sy = y0<y1 ? 1 : -1;
		var err = dx+dy, e2;

		var i;
		for(;;){
			i= (x0*this._channels) + channelId;
			this._resampleBuffer[i]= this.readFloatSample(buffer, (y0*this._channels) + channelId);

			if (x0>=x1 && y0>=y1) { break; }
			e2 = 2*err;
			if (e2 > dy) { err += dy; x0 += sx; }
			if (e2 < dx) { err += dx; y0 += sy; }
		}
	}, 
	getResampleBuffer: function() {
		return this._resampleBuffer;
	}
};

/*
* Emscripten based backends that produce 16-bit sample data.
*
* NOTE: This impl adds handling for asynchronously initialized 'backends', i.e.
*       the 'backend' that is passed in, may not yet be usable (see WebAssebly based impls: 
*       here a respective "onRuntimeInitialized" event will eventually originate from the 'backend'). 
*       The 'backend' allows to register a "adapterCallback" hook to propagate the event - which is
*       used here. The player typically observes the backend-adapter and when the adapter state changes, a 
*       "notifyAdapterReady" is triggered so that the player is notified of the change.
*/
EmsHEAP16BackendAdapter = (function(){ var $this = function (backend, channels) { 
		$this.base.call(this, channels, 2);
		this.Module= backend;
		
		// required if WASM (asynchronously loaded) is used in the backend impl
		this.Module["adapterCallback"] = function() { 	// when Module is ready			
			this.doOnAdapterReady();	// hook allows to perform additional initialization	
			this.notifyAdapterReady();	// propagate to change to player
		}.bind(this);
		
		if (!window.Math.fround) { window.Math.fround = window.Math.round; } // < Chrome 38 hack
	}; 
	extend(AudioBackendAdapterBase, $this, {
		doOnAdapterReady: function() { },		// noop, to be overridden in subclasses 
				
		/* async emscripten init means that adapter may not immediately be ready - see async WASM compilation */
		isAdapterReady: function() { 
			if (typeof this.Module.notReady === "undefined")	return true; // default for backward compatibility		
			return !this.Module.notReady;
		},		
		registerEmscriptenFileData: function(pathFilenameArray, data) {
			// create a virtual emscripten FS for all the songs that are touched.. so the compiled code will
			// always find what it is looking for.. some players will look to additional resource files in the same folder..

			// Unfortunately the FS.findObject() API is not exported.. so it's exception catching time
			try {
				this.Module.FS_createPath("/", pathFilenameArray[0], true, true);
			} catch(e) {
			}
			var f;
			try {
				f= this.Module.FS_createDataFile(pathFilenameArray[0], pathFilenameArray[1], data, true, true);
				
				var p= ScriptNodePlayer.getInstance().trace("registerEmscriptenFileData: [" +
						pathFilenameArray[0]+ "][" +pathFilenameArray[1]+ "] size: "+ data.length);

			} catch(err) {
				// file may already exist, e.g. drag/dropped again.. just keep entry
				
			}
			return f;		
		},	
		readFloatSample: function(buffer, idx) {
			return (this.Module.HEAP16[buffer+idx])/0x8000;
		},
		/* try to speed-up copy operation by inlining the access logic (which does indeed 
		 * seem to make a difference) 
		 */
		getCopiedAudio: function(buffer, len) {
			var i= 0;
			// just copy the rescaled values so there is no need for special handling in playback loop
			for(i= 0; i<len*this._channels; i++){
				this._resampleBuffer[i]= (this.Module.HEAP16[buffer+i])/0x8000;
			}		
			return len;	
		}
	
	});	return $this; })();	

// cache all loaded files in global cache.
FileCache = function() {
	this._binaryFileMap= {};	// cache for loaded "file" binaries
	this._pendingFileMap= {};

	this._isWaitingForFile= false;	// signals that some file loading is still in progress
};

FileCache.prototype = {
	getFileMap: function () {
		return this._binaryFileMap;
	},
	getPendingMap: function () {
		return this._pendingFileMap;
	},
	setWaitingForFile: function (val) {
		this._isWaitingForFile= val;
	},
	isWaitingForFile: function () {
		return this._isWaitingForFile;
	},
	getFile: function (filename) {
		var data;
		if (filename in this._binaryFileMap) {
			data= this._binaryFileMap[filename];
		}
		return data;
	},
	
	// FIXME the unlimited caching of files should probably be restricted:
	// currently all loaded song data stays in memory as long as the page is opened
	// maybe ist add some manual "reset"? 
	setFile: function(filename, data) {
		this._binaryFileMap[filename]= data;
		this._isWaitingForFile= false;
	}

};


/**
* Generic ScriptProcessor based WebAudio music player (end user API). 
*
* <p>Deals with the WebAudio node pipeline, feeds the sample data chunks delivered by 
* the backend into the WebAudio input buffers, provides basic file input facilities.
*
* This player is used as a singleton (i.e. instanciation of a player destroys the previous one).
*
* GUI can use the player via:
*	    ScriptNodePlayer.createInstance(...); and 
*       ScriptNodePlayer.getInstance();
*/
var ScriptNodePlayer = (function () {
	/*
	* @param externalTicker must be a subclass of AbstractTicker
	*/
	PlayerImpl = function(backendAdapter, basePath, requiredFiles, spectrumEnabled, onPlayerReady, onTrackReadyToPlay, onTrackEnd, onUpdate, externalTicker) {
		if(typeof backendAdapter === 'undefined')		{ alert("fatal error: backendAdapter not specified"); }
		if(typeof onPlayerReady === 'undefined')		{ alert("fatal error: onPlayerReady not specified"); }
		if(typeof onTrackReadyToPlay === 'undefined')	{ alert("fatal error: onTrackReadyToPlay not specified"); }
		if(typeof onTrackEnd === 'undefined')			{ alert("fatal error: onTrackEnd not specified"); }

		if (backendAdapter.getChannels() >2) 			{ alert("fatal error: only 1 or 2 output channels supported"); }
		this._backendAdapter= backendAdapter;
		this._backendAdapter.setObserver(this);
				
		this._basePath= basePath;
		this._traceSwitch= false;
		
		this._spectrumEnabled= spectrumEnabled;
		
		// container for song infos like: name, author, etc
		this._songInfo = {};
			
		// hooks that allow to react to specific events
		this._onTrackReadyToPlay= onTrackReadyToPlay;
		this._onTrackEnd= onTrackEnd;
		this._onPlayerReady= onPlayerReady;
		this._onUpdate= onUpdate;	// optional
		
		
		// "external ticker" allows to sync separately maintained data with the actual audio playback
		this._tickerStepWidth= 256;		// shortest available (i.e. tick every 256 samples)
		if(typeof externalTicker !== 'undefined') {
			externalTicker.init(SAMPLES_PER_BUFFER, this._tickerStepWidth);
		}
	    this._externalTicker = externalTicker;
		this._currentTick= 0;
		
		
		// audio buffer handling
		this._sourceBuffer;
		this._sourceBufferLen;
		this._numberOfSamplesRendered= 0;
		this._numberOfSamplesToRender= 0;
		this._sourceBufferIdx=0;	
		
		// // additional timeout based "song end" handling
		this._currentPlaytime= 0;
		this._currentTimeout= -1;		
		
		setGlobalWebAudioCtx();

		this._sampleRate = window._gPlayerAudioCtx.sampleRate;
		this._correctSampleRate= this._sampleRate;			
		this._backendAdapter.resetSampleRate(this._sampleRate, -1);

			// general WebAudio stuff
		this._bufferSource;
		this._gainNode;
		this._panNode;
		this._analyzerNode;
		this._scriptNode;
		this._freqByteData = 0; 
		
		this._pan= 0;	// unchanged
		
		// the below entry points are published globally they can be 
		// easily referenced from the outside..
				
		window.fileRequestCallback= this.fileRequestCallback.bind(this);
		window.fileSizeRequestCallback= this.fileSizeRequestCallback.bind(this);
		window.songUpdateCallback= this.songUpdateCallback.bind(this);
		
		// --------------- player status stuff ----------
		
		this._isPaused= false;					// 'end' of a song also triggers this state
		
		// setup asyc completion of initialization
		this._isPlayerReady= false;		// this state means that the player is initialized and can be used now
		this._isSongReady= false;		// initialized (including file-loads that might have been necessary)
		this._initInProgress= false;
		
		this._preLoadReady= false;

		window.player= this;
		
		var f= window.player['preloadFiles'].bind(window.player);
		f(requiredFiles, function() {
			this._preLoadReady= true;
			if (this._preLoadReady && this._backendAdapter.isAdapterReady() && this._backendAdapter.isManualSetupComplete()) {
				this._isPlayerReady= true;
				this._onPlayerReady();
			}
		}.bind(this));
	};


	PlayerImpl.prototype = {
	
// ******* general
		notify: function() {	// used to handle asynchronously initialized backend impls
			if ((typeof this.deferredPreload !== "undefined") && this._backendAdapter.isAdapterReady()) {
				// now that the runtime is ready the "preload" can be started
				var files= this.deferredPreload[0];
				var onCompletionHandler= this.deferredPreload[1];
				delete this.deferredPreload;
				
				this.preload(files, files.length, onCompletionHandler);
			}
		
			if (!this._isPlayerReady && this._preLoadReady && this._backendAdapter.isAdapterReady() && this._backendAdapter.isManualSetupComplete()) {
				this._isPlayerReady= true;
				this._onPlayerReady();
			}			
		},
		handleBackendEvent: function() { this.notify(); }, // deprecated, use notify()!
		
		/**
		* Is the player ready for use? (i.e. initialization completed)
		*/
		isReady: function() {
			return this._isPlayerReady;	
		},
	
		/**
		* Turn on debug output to JavaScript console.
		*/
		setTraceMode: function (on) {
			this._traceSwitch= on;
		},
		
// ******* basic playback features

		/*
		* start audio playback
		*/
		play: function() {
			this.initWebAudio();
		
			this._isPaused= false;

			if (typeof this._bufferSource === 'undefined') {
				this._bufferSource = window._gPlayerAudioCtx.createBufferSource();
				if (!this._bufferSource.start) {
				  this._bufferSource.start = this._bufferSource.noteOn;
				  this._bufferSource.stop = this._bufferSource.noteOff;
				}
				this._bufferSource.start(0);		
			}
		},		
		/*
		* pause audio playback
		*/
		pause: function() {		
			if ((!this.isWaitingForFile()) && (!this._initInProgress) && this._isSongReady) {
				this._isPaused= true;
			}
		},
		isPaused: function() {		
			return this._isPaused;
		},

		/*
		* resume audio playback
		*/
		resume: function() {
			if ((!this.isWaitingForFile()) && (!this._initInProgress) && this._isSongReady) {
				this._isPaused= false;
			}
		},
				
		/*
		* gets the index of the 'tick' that is currently playing.
		* allows to sync separately stored data with the audio playback.
		*/
		getCurrentTick: function() {
			var idx= Math.ceil(SAMPLES_PER_BUFFER/this._tickerStepWidth)-1;			
			idx= Math.min(idx, this._currentTick)
			return idx;
		},
		
		/*
		* set the playback volume (input between 0 and 1)
		*/
		setVolume: function(value) {
			if (typeof this._gainNode != 'undefined') { 
				this._gainNode.gain.value= value;
			}
		},
		
		getVolume: function() {
			if (typeof this._gainNode != 'undefined') { 
				return this._gainNode.gain.value;
			}
			return -1;
		},
		/**
		* May be a no-op if browser does not support StereoPannerNode
		* @value -1 to 1
		*/
		setPanning: function(value) {
			this._pan= value;	// in case the WebAudio chain has not been setup yet
			
			if ((typeof this._panNode != 'undefined') && ( this._panNode != null)) {				
				this._panNode.pan.setValueAtTime(value, window._gPlayerAudioCtx.currentTime);
			}
		},
		
		/*
		* is playback in stereo?
		*/
		isStereo: function() {
			return this._backendAdapter.getChannels() == 2;
		},

		/**
		* Get backend specific song infos like 'author', 'name', etc.
		*/
		getSongInfo: function () {
			return this._songInfo;
		},
		
		/**
		* Get meta info about backend specific song infos, e.g. what attributes are available and what type are they.
		*/
		getSongInfoMeta: function() {
			return this._backendAdapter.getSongInfoMeta();
		},
		
		/*
		* Manually defined playback time to use until 'end' of a track (only affects the
		* currently selected track).
		* @param t time in millis
		*/
		setPlaybackTimeout: function(t) {
			this._currentPlaytime= 0;
			if (t<0) {
				this._currentTimeout= -1;
			} else {
				this._currentTimeout= t/1000*this._sampleRate;
			}
		},
		/*
		* Timeout in seconds.
		*/
		getPlaybackTimeout: function() {
			if (this._currentTimeout < 0) {
				return -1;
			} else {
				return Math.round(this._currentTimeout/this._sampleRate);
			}
		},

		getCurrentPlaytime: function() {
			return Math.round(this._currentPlaytime/this._sampleRate);
		},
		
// ******* access to frequency spectrum data (if enabled upon construction)
		
		getFreqByteData: function () {
			if (this._analyzerNode) {
				if (this._freqByteData === 0) {
					this._freqByteData = new Uint8Array(this._analyzerNode.frequencyBinCount);	
				}
				this._analyzerNode.getByteFrequencyData(this._freqByteData);
			}
			return this._freqByteData;
		},

// ******* song "position seek" related (if available with used backend)

		/** 
		* Return: default 0 seeking not supported 
		*/
		getMaxPlaybackPosition: function() 				{ return this._backendAdapter.getMaxPlaybackPosition();},

		/** 
		* Return: default 0 
		*/
		getPlaybackPosition: function() 				{ return this._backendAdapter.getPlaybackPosition();},
		
		/** 
		* Move playback to 'pos': must be between 0 and getMaxSeekPosition()
		* Return: 0 if successful
		*/
		seekPlaybackPosition: function(pos) 				{ return this._backendAdapter.seekPlaybackPosition(pos);},
		
// ******* (music) file input related
		
		/**
		* Loads from a JavaScript File object - e.g. used for 'drag & drop'.
		*/
		loadMusicFromTmpFile: function (file, options, onCompletion, onFail, onProgress) {
			var filename= file.name;	// format detection may depend on prefixes and postfixes..

			var fullFilename= ((options.basePath)?options.basePath:this._basePath) + filename;	// this._basePath ever needed?
			if (this.loadMusicDataFromCache(fullFilename, options, onFail)) { return; }

			var reader = new FileReader();
			reader.onload = function() {
			
				var pfn= this._backendAdapter.getPathAndFilename(filename);
				var data= new Uint8Array(reader.result);
				var fileHandle= this._backendAdapter.registerFileData(pfn, data);
				if (typeof fileHandle === 'undefined' ) {
					onFail();
					return;
				} else {				
					var cacheFilename= this._backendAdapter.mapCacheFileName(fullFilename);
					this.getCache().setFile(cacheFilename, data);			
				}
				this.prepareTrackForPlayback(fullFilename, reader.result, options);
				onCompletion(filename);
			}.bind(this);
			reader.onprogress = function (oEvent) {
				if (onProgress) {
					onProgress(oEvent.total, oEvent.loaded);
				}
			}.bind(this);		
			
			reader.readAsArrayBuffer(file);
		},
		
		/**
		* Loads from an URL.
		*/
		loadMusicFromURL: function(url, options, onCompletion, onFail, onProgress) {
			var fullFilename= this._backendAdapter.mapInternalFilename(options.basePath, this._basePath, url);
			
			if (this.loadMusicDataFromCache(fullFilename, options, onFail)) { return; }
			
			var xhr = new XMLHttpRequest();
			xhr.open("GET", this._backendAdapter.mapUrl(fullFilename), true);
			xhr.responseType = "arraybuffer";
			
			xhr.onload = function (oEvent) {
					this.trace("loadMusicFromURL successfully loaded: "+ fullFilename);
					
					if(!this.prepareTrackForPlayback(fullFilename, xhr.response, options)) {
						if (!this.isWaitingForFile()) {
							onFail();
						}
					} else {
						onCompletion(fullFilename);					
					}
					/*else {		// playback should be started from _onTrackReadyToPlay()
						this.play();
					}*/				
			}.bind(this);
			xhr.onprogress = function (oEvent) {
				if(onProgress) {
					onProgress(oEvent.total, oEvent.loaded);
				}
			}.bind(this);		
			xhr.onreadystatuschange = function (oEvent) {
			  if (oReq.readyState==4 && oReq.status==404) {
				this.trace("loadMusicFromURL failed to load: "+ fullFilename);				
			  }
			}.bind(this);	
		
			xhr.send(null);
		},
		
		/*
		* Manually perform some file input based initialization sequence -
		* as/if required by the backend. (only needed for special cases)
		*/
		uploadFile: function (file, options, onCompletion, onFail, onProgress) {
			var reader = new FileReader();
			reader.onload = function() {
				var pfn= this._backendAdapter.getPathAndFilename(file.name);
				var data= new Uint8Array(reader.result);
				var fileHandle= this._backendAdapter.registerFileData(pfn, data);
				if (typeof fileHandle === 'undefined' ) {
					onFail();
					return;
				}	
				var status = this._backendAdapter.uploadFile(file.name, options);
				if (status === 0) {
					onCompletion(file.name);
					this._onPlayerReady();
				} else if (status == 1) {
					onCompletion(file.name);
				}				
			}.bind(this);
			reader.onprogress = function (oEvent) {
				if (onProgress) {
					onProgress(oEvent.total, oEvent.loaded);
				}
			}.bind(this);		
			
			reader.readAsArrayBuffer(file);
		},
								
// ******** internal utils (MUST NOT be ued outside of the player or respective backendAdapters --------------

		/**
		* Load a music data and prepare to play a specific track.
		*/
		prepareTrackForPlayback: function (fullFilename, data, options) {
			this._isPaused= true;
		
			// hack: so we get back at the options during retry attempts
			this.lastUsedFilename= fullFilename;
			this.lastUsedData= data;
			this.lastUsedOptions= options;
			
			this._isSongReady= false;
			this.setWaitingForFile(false);
			
			return this.initIfNeeded(fullFilename, data, options);
		},
		trace: function(str) {
			if (this._traceSwitch) { console.log(str); }
		},
		setWait: function(isWaiting) {
			this.setWaitingForFile(isWaiting);
		},
		getDefaultSampleRate: function() {
			return this._correctSampleRate;
		},		
		initIfNeeded: function (fullFilename, data, options) {
			var status= this.loadMusicData(fullFilename, data, options);
			if (status <0) {
				this._isSongReady= false;
				this.setWaitingForFile(true);
				this._initInProgress= false;
			
			} else if (status === 0) {
			//	this._isPaused= false;
				this.setWaitingForFile(false);
				this._isSongReady= true;
				this._currentPlaytime= 0;
				this._initInProgress= false;

				this.trace("successfully completed init");				
			
				// in scenarios where a synchronous file-load is involved this first call will typically fail 
				// but trigger the file load
				var ret= this._backendAdapter.evalTrackOptions(options);
				if (ret !== 0) {
					this.trace("error preparing track options");
					return false;
				}
				this.updateSongInfo(fullFilename);	  
				
				this._onTrackReadyToPlay();
				
				this._isPaused= false;
				return true;		

			} else {
				this._initInProgress= false;
				// error that cannot be resolved.. (e.g. file not exists)
				this.trace("initIfNeeded - fatal error");
//				if (this.onError) this.onError();	// so far is doesn't seem that we need an onError..
			}
			return false;
		},
		loadMusicDataFromCache: function(fullFilename, options, onFail) {
			// reset timeout handling (of previous song.. which still might be playing)
			this._currentTimeout= -1;
			this._currentPlaytime= 0;
			this._isPaused= true;
				
			var cacheFilename= this._backendAdapter.mapCacheFileName(fullFilename);
			var data= this.getCache().getFile(cacheFilename);
			
			if (typeof data != 'undefined') {				
				if(!this.prepareTrackForPlayback(fullFilename, data, options)) {
					if (!this.isWaitingForFile()) {
						onFail();
					} else {
					}
				}
				return true;
			}
			return false;
		},	
		//init WebAudio node pipeline
		initWebAudio: function() {
			if (typeof this._bufferSource != 'undefined') {
				try {
					this._bufferSource.stop(0);
				} catch(err) {/* ignore for the benefit of Safari(OS X) */}
			} else {						
				this._analyzerNode = window._gPlayerAudioCtx.createAnalyser();
				this._scriptNode= this.createScriptProcessor(window._gPlayerAudioCtx);
				this._gainNode = window._gPlayerAudioCtx.createGain();	
				
				this._scriptNode.connect(this._gainNode);				

				// optional add-on
				if (typeof this._externalTicker !== 'undefined') {
					var tickerScriptNode= this.createTickerScriptProcessor(window._gPlayerAudioCtx);
					tickerScriptNode.connect(this._gainNode);
				}
				
				// use panner if supported by the browser (i.e. not IE or Safari crap)
				var source= this._gainNode;				
				this._panNode= null;
				try {					
					this._panNode= window._gPlayerAudioCtx.createStereoPanner();
					source.connect(this._panNode);
					source = this._panNode;
					
					this.setPanning(this._pan);
				} catch (ignore) {}				
				
				if (this._spectrumEnabled) {
					source.connect(this._analyzerNode);
					this._analyzerNode.connect(window._gPlayerAudioCtx.destination);
				} else {
					source.connect(window._gPlayerAudioCtx.destination);
				}
			}
		},
		updateSongInfo: function (fullFilename) {
			this._songInfo= {};
			this._backendAdapter.updateSongInfo(fullFilename, this._songInfo);
		},			
		loadMusicData: function(fullFilename, arrayBuffer, options) {
			this._backendAdapter.teardown();

			if (arrayBuffer) {
				var pfn= this._backendAdapter.getPathAndFilename(fullFilename);
				
				var data= new Uint8Array(arrayBuffer);
				this._backendAdapter.registerFileData(pfn, data);	// in case the backend "needs" to retrieve the file by name 
				
				// FIXME regression test
				var cacheFilename= this._backendAdapter.mapCacheFileName(fullFilename);
				this.getCache().setFile(cacheFilename, data);			
				// FIXME regression test
				
				var ret= this._backendAdapter.loadMusicData(this._sampleRate, pfn[0], pfn[1], data, options);

				if (ret === 0) {			
					this.resetBuffer();
				}		
				return ret;
			}
		},
		resetBuffer: function () {
			this._numberOfSamplesRendered= 0;
			this._numberOfSamplesToRender= 0;
			this._sourceBufferIdx=0;		
		},
		resetSampleRate: function(sampleRate) {
			// override the default (correct) sample rate to make playback faster/slower
			this._backendAdapter.resetSampleRate(sampleRate, -1);
			this.resetBuffer();
		},
		createScriptProcessor: function(audioCtx) {
			// use the number of channels that the backend wants
			var scriptNode = audioCtx.createScriptProcessor(SAMPLES_PER_BUFFER, 0, this._backendAdapter.getChannels());	
			scriptNode.onaudioprocess = fetchSamples;
		//	scriptNode.onaudioprocess = player.generateSamples.bind(player);	// doesn't work with dumbshit Chrome GC
			return scriptNode;
		},
		createTickerScriptProcessor: function(audioCtx) {
			var scriptNode;
			// "ticker" uses shortest buffer length available so that onaudioprocess
			// is invoked more frequently than the above scriptProcessor.. it is the purpose
			// of the "ticker" to supply data that is used for an "animation frame" (e.g. to display a VU meter), 
			// i.e. accuracy is not a big issue since we are talking about 60fps.. (at 48000kHz the 256 sample 
			// buffer would work up to 187.5 fps.. only people using unusually high playback rates might touch the limit..)
			
			// this script processor does not actually produce any audible output.. it just provides a callback
			// that is synchronized with the actual music playback.. (the alternative would be to manually try and 
			// keep track of the playback progress..)
			scriptNode = audioCtx.createScriptProcessor(256, 0, 1);	
			scriptNode.onaudioprocess = calcTick;
			return scriptNode;
		},
		fillEmpty: function(outSize, output1, output2) {
			var availableSpace = outSize-this._numberOfSamplesRendered;
			
			for (i= 0; i<availableSpace; i++) {
				output1[i+this._numberOfSamplesRendered]= 0;
				if (this.isStereo()) { output2[i+this._numberOfSamplesRendered]= 0; }
			}				
			this._numberOfSamplesToRender = 0;
			this._numberOfSamplesRendered = outSize;			
		},
		
		// ------------------- async file-load ( also explained in introduction above) --------------------------------

		// backend attempts to read some file using fileRequestCallback() function: if the file is available 
		// (i.e. its binary data has already been loaded) the function signals the success by returning 0. 
		// If the file has not yet been loaded the function returns -1. 
		// As soon as the player completes an asynchronous file-load it passes the loaded data to the backendAdapter's 
		// registerFileData() API. It is then up to the backendAdapter's impl to create some filename based file 
		// cache which is used by the backend to retrieve "available" files. (Example: An Emscripten based backend uses 
		// Emscripten's virtual FS and "normal" File IO APIs to access files. The respective backendAdaper.registerFileData() 
		// implemntation just creates respective File nodes with the data it receives..) 
				
		fileRequestCallback: function (name) {
			var fullFilename = this._backendAdapter.mapBackendFilename(name);	
			
			return this.preloadFile(fullFilename, function() {
								this.initIfNeeded(this.lastUsedFilename, this.lastUsedData, this.lastUsedOptions);
						}.bind(this), false);	
		},	
		// convenience API which lets backend directly query the file size
		fileSizeRequestCallback: function (name) {
			var filename= this._backendAdapter.mapBackendFilename(name);
			var cacheFilename= this._backendAdapter.mapCacheFileName(filename);
			var f= this.getCache().getFile(cacheFilename);	// this API is only called after the file has actually loaded
			return f.length;
		},
		
		// may be invoked by backend to "push" updated song attributes (some backends only "learn" about infos
		// like songname, author, etc while the song is actually played..)
		songUpdateCallback:function(attr) {
			// notification that emu has updated infos regarding the currently played song..
			this._backendAdapter.handleBackendSongAttributes(attr, this._songInfo);
		
			if(this._onUpdate) {
				this._onUpdate();
			}
		},
				
		// -------------------------------------------------------------------------------------------------------
		
		preload: function(files, id, onCompletionHandler) {
			if (id === 0) {
				// we are done preloading
				onCompletionHandler();
			} else {
				id--;
				var funcCompleted= function() {this.preload(files, id, onCompletionHandler);}.bind(this); // trigger next load
				this.preloadFile(files[id], funcCompleted, true);	
			}
		},
		preloadFile: function (fullFilename, onLoadedHandler, notifyOnCached) {
			// note: function is used for "preload" and for "backend callback" loading... return values
			// are only used for the later
			
			var cacheFilename= this._backendAdapter.mapCacheFileName(fullFilename);
			var data= this.getCache().getFile(cacheFilename);
			if (typeof data != 'undefined')	{
				var retVal= 0;
				// the respective file has already been setup
				if (data == 0) {
					retVal= 1;
					this.trace("error: preloadFile could not get cached: "+ fullFilename);
				}
				if(notifyOnCached)
					onLoadedHandler();	// trigger next in chain	  needed for preload / but hurts "backend callback"
				return retVal;
			}

			// backend will be stuck without this file and we better make 
			// sure to not use it before it has been properly reinitialized
			this._isPaused= true;
			this.setWaitingForFile(true);
			this._isSongReady= false;
					
			// requested data not available.. we better load it for next time
			if (!(cacheFilename in this.getCache().getPendingMap())) {		// avoid duplicate loading
				this.getCache().getPendingMap()[cacheFilename] = 1;

				var oReq = new XMLHttpRequest();
				oReq.open("GET", this._backendAdapter.mapUrl(fullFilename), true);
				oReq.responseType = "arraybuffer";

				oReq.onload = function (oEvent) {
					var arrayBuffer = oReq.response;
					if (arrayBuffer) {
						this.trace("preloadFile successfully loaded: "+ fullFilename);

						// setup data in our virtual FS (the next access should then be OK)
						var pfn= this._backendAdapter.getPathAndFilename(fullFilename);
						var data= new Uint8Array(arrayBuffer);
						var f= this._backendAdapter.registerFileData(pfn, data);

						this.getCache().setFile(cacheFilename, data);			
					}
					if(!delete this.getCache().getPendingMap()[cacheFilename]) {
						this.trace("remove file from pending failed: "+cacheFilename);
					}
					onLoadedHandler();
				}.bind(this);
				oReq.onreadystatuschange = function (oEvent) {
				  if (oReq.readyState==4 && oReq.status==404) {
					this.trace("preloadFile failed to load: "+ fullFilename);
					
					this.getCache().setFile(cacheFilename, 0);							
				  }
				}.bind(this);
				oReq.onerror  = function (oEvent) {
				
					this.getCache().setFile(cacheFilename, 0);			
				}.bind(this);

				oReq.send(null);
			}
			return -1;	
		},
		tick: function(event) {
			this._currentTick++;
		},		
		// called for 'onaudioprocess' to feed new batch of sample data
		genSamples: function(event) {		
			var output1 = event.outputBuffer.getChannelData(0);
			var output2;
			if (this.isStereo()) {
				output2 = event.outputBuffer.getChannelData(1);
			}
			if ((!this._isSongReady) || this.isWaitingForFile() || this._isPaused) {
				var i;
				for (i= 0; i<output1.length; i++) {
					output1[i]= 0;
					if (this.isStereo()) { output2[i]= 0; }
				}		
			} else {
				var outSize= output1.length;
				
				this._numberOfSamplesRendered = 0;		

				while (this._numberOfSamplesRendered < outSize)
				{
					if (this._numberOfSamplesToRender === 0) {
					
						var status;		
						if ((this._currentTimeout>0) && (this._currentPlaytime > this._currentTimeout)) {
							this.trace("'song end' forced after "+ this._currentTimeout/this._sampleRate +" secs");
							status= 1;
						} else {
							status = this._backendAdapter.computeAudioSamples();
							if (typeof this._externalTicker !== 'undefined') {
								this._externalTicker.computeAudioSamplesNotify();
							}
						}
										
						if (status !== 0) {
							// no frame left
							this.fillEmpty(outSize, output1, output2);
							
							if (status <0) {
								// file-load: emu just discovered that we need to load another file
								this._isPaused= true;
								this._isSongReady= false; 		// previous init is invalid
								this.setWaitingForFile(true);
								return; // complete init sequence must be repeated
							}
							if (this.isWaitingForFile()) {
								// this state may just have been set by the backend.. try again later
								return;
							} else {
								if (status > 1)	{
									this.trace("playback aborted with an error");
//									this.onError();	// so far is doesn't seem that we need an onError..
								}
								
								// note: this code will also be hit if additional load is triggered 
								// from the playback, i.e. exclude that case
								if (this._onTrackEnd) {
									this._onTrackEnd();
								} else {
									// FIXME regression test
									this._isPaused= true;
								}
								return;							
							}
						}
						// refresh just in case they are not using one fixed buffer..
						this._sourceBuffer= this._backendAdapter.getAudioBuffer();
						this._sourceBufferLen= this._backendAdapter.getAudioBufferLength();

						this._numberOfSamplesToRender =  this._backendAdapter.getResampledAudio(this._sourceBuffer, this._sourceBufferLen);
						
						this._sourceBufferIdx=0;			
					}
										
					var resampleBuffer= this._backendAdapter.getResampleBuffer();
					if (this.isStereo()) {
						this.copySamplesStereo(resampleBuffer, output1, output2, outSize);
					} else {
						this.copySamplesMono(resampleBuffer, output1, output2, outSize);
					}
				}
				
				this._currentPlaytime+= outSize;	// keep track how long we are playing
			}
			if (typeof this._externalTicker !== 'undefined') {
				this._externalTicker.calcTickData(output1, output2);
				this._currentTick= 0;
			}
		},
		copySamplesStereo: function(resampleBuffer, output1, output2, outSize) {
			var i;
			if (this._numberOfSamplesRendered + this._numberOfSamplesToRender > outSize) {
				var availableSpace = outSize-this._numberOfSamplesRendered;
				
				for (i= 0; i<availableSpace; i++) {
					output1[i+this._numberOfSamplesRendered]= resampleBuffer[this._sourceBufferIdx++];
					output2[i+this._numberOfSamplesRendered]= resampleBuffer[this._sourceBufferIdx++];
				}				
				this._numberOfSamplesToRender -= availableSpace;
				this._numberOfSamplesRendered = outSize;
			} else {
				for (i= 0; i<this._numberOfSamplesToRender; i++) {
					output1[i+this._numberOfSamplesRendered]= resampleBuffer[this._sourceBufferIdx++];
					output2[i+this._numberOfSamplesRendered]= resampleBuffer[this._sourceBufferIdx++];
				}						
				this._numberOfSamplesRendered += this._numberOfSamplesToRender;
				this._numberOfSamplesToRender = 0;
			} 	
		},
		copySamplesMono: function(resampleBuffer, output1, output2, outSize) {
			var i;
			if (this._numberOfSamplesRendered + this._numberOfSamplesToRender > outSize) {
				var availableSpace = outSize-this._numberOfSamplesRendered;
				
				for (i= 0; i<availableSpace; i++) {
					output1[i+this._numberOfSamplesRendered]= resampleBuffer[this._sourceBufferIdx++];
				}				
				this._numberOfSamplesToRender -= availableSpace;
				this._numberOfSamplesRendered = outSize;
			} else {
				for (i= 0; i<this._numberOfSamplesToRender; i++) {
					output1[i+this._numberOfSamplesRendered]= resampleBuffer[this._sourceBufferIdx++];
				}						
				this._numberOfSamplesRendered += this._numberOfSamplesToRender;
				this._numberOfSamplesToRender = 0;
			} 	
		},
		
		
		
		// Avoid the async trial&error loading (if available) for those files that 
		// we already know we'll be needing
		preloadFiles: function(files, onCompletionHandler) {
			this._isPaused= true;
			
			if (this._backendAdapter.isAdapterReady()) {
				// sync scenario: runtime is ready
				this.preload(files, files.length, onCompletionHandler);
			} else {
				// async scenario:  runtime is NOT ready (e.g. emscripten WASM)
				this["deferredPreload"] = [files, onCompletionHandler]; 
			}			
		},
		setWaitingForFile: function(val) {
			this.getCache().setWaitingForFile(val);
		},
		isWaitingForFile: function() {
			return this.getCache().isWaitingForFile();
		},
		getCache: function() {
			if(typeof window._fileCache == 'undefined')
				window._fileCache= new FileCache();
				
			return window._fileCache;
		}		
	};

    return {
	    createInstance: function(backendAdapter, basePath, requiredFiles, enableSpectrum,
								onPlayerReady, onTrackReadyToPlay, onTrackEnd, doOnUpdate, externalTicker) {
					
			var trace= false;
			if (typeof window.player != 'undefined' ) {			// stop existing pipeline
				var old= window.player;
				old._isPaused= true;
				
				if (typeof old._bufferSource != 'undefined') { 
					try {
						old._bufferSource.stop(0);
					} catch(err) {/* ignore for the benefit of Safari(OS X) */}
				}			
				if (old._scriptNode) old._scriptNode.disconnect(0);
				if (old._analyzerNode) old._analyzerNode.disconnect(0);
				if (old._gainNode) old._gainNode.disconnect(0);
				
				trace= old._traceSwitch;
			}
			var p = new PlayerImpl(backendAdapter, basePath, requiredFiles, enableSpectrum,
								onPlayerReady, onTrackReadyToPlay, onTrackEnd, doOnUpdate, externalTicker);
			p._traceSwitch= trace;
		},
        getInstance: function () {
			if (typeof window.player === 'undefined' ) {
				alert("fatal error: window.player not defined");
			}
			return window.player;
        }
    };
})();