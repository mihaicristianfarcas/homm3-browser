# Emscripten build: SDL2 comes from the Emscripten ports system
if(NOT TARGET SDL2::SDL2)
	add_library(SDL2::SDL2 INTERFACE IMPORTED)
	target_compile_options(SDL2::SDL2 INTERFACE "-sUSE_SDL=2")
	target_link_options(SDL2::SDL2 INTERFACE "-sUSE_SDL=2")
endif()
set(SDL2_FOUND TRUE)
