# Emscripten build: SDL2_mixer comes from the Emscripten ports system
if(NOT TARGET SDL2::Mixer)
	add_library(SDL2::Mixer INTERFACE IMPORTED)
	target_compile_options(SDL2::Mixer INTERFACE "-sUSE_SDL_MIXER=2")
	target_link_options(SDL2::Mixer INTERFACE "-sUSE_SDL_MIXER=2" "-sSDL2_MIXER_FORMATS=mp3,ogg")
endif()
set(SDL2_mixer_FOUND TRUE)
