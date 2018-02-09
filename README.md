# Generic ScriptProcessor based WebAudio player 

version 1.02
Copyright (C) 2015 Juergen Wothke

This player relies on WebAudio ScriptProcessor generated sample data, i.e. is can be used 
whenever there is an audio source that directly produces audio sample data. So far it has 
proved useful for porting nine different C/C++ based chiptune players to the Web (see my 
other projects).

The player makes provisions for audio re-sampling (if necessary) and uses a trial/error/retry 
scheme to facilitate the migration to "synchronous file load" based programs to the 
"asynchronous file load" world of the Web (example: webuade). The player can also be reconfigured 
at runtime to deal with different audio sources (see http://www.wothke.ch/blaster/)

The player is totally generic and any logic specific to a particular audio source (backend) 
must be provided as a separate BackendAdapter. Specifically for those cases where the audio 
source is some program compiled using Emscripten the player provides respective utility APIs.

In order to use this player with a new audio source you have to write a respective 
*BackendAdapter implementation. Unfortunately at the moment there isn't any documentation (in 
addition to the occasional comment present in the non-minified *.js file). However the 
nine chiptune players mentioned above provide examples to learn from..

Note: In order to use WebAssembly based backends (all my backends can optionally be compiled 
to WebAssembly) you'll need at least version 1.02 of the player (older versions are not
equipped to deal with the asynchonous initialization).

	
## License	
	Terms of Use: This software is licensed under a CC BY-NC-SA 
	(http://creativecommons.org/licenses/by-nc-sa/4.0/).
