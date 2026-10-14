# Emscripten build: SDL2_image comes from the Emscripten ports system
if(NOT TARGET SDL2::Image)
	add_library(SDL2::Image INTERFACE IMPORTED)
	target_compile_options(SDL2::Image INTERFACE "-sUSE_SDL_IMAGE=2")
	target_link_options(SDL2::Image INTERFACE "-sUSE_SDL_IMAGE=2" "-sSDL2_IMAGE_FORMATS=png,bmp,jpg")
endif()
set(SDL2_image_FOUND TRUE)
