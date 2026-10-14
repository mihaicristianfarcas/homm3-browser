# Emscripten build: SDL2_ttf comes from the Emscripten ports system
if(NOT TARGET SDL2::TTF)
	add_library(SDL2::TTF INTERFACE IMPORTED)
	target_compile_options(SDL2::TTF INTERFACE "-sUSE_SDL_TTF=2")
	target_link_options(SDL2::TTF INTERFACE "-sUSE_SDL_TTF=2")
endif()
set(SDL2_ttf_FOUND TRUE)
