/*
 * WebPlatform.cpp, part of VCMI engine
 *
 * Authors: listed in file AUTHORS in main folder
 *
 * License: GNU General Public License v2.0 or later
 * Full text of license available in license.txt file, in main folder
 *
 */
#include "StdInc.h"
#include "WebPlatform.h"

#ifdef VCMI_EMSCRIPTEN

#include "../client/GameInstance.h"

#include <emscripten/emscripten.h>
#include <emscripten/wasmfs.h>

// Implemented in clientapp/web/library_vcmi.js
extern "C" void vcmi_web_notify(char * event, char * detail);

namespace WebPlatform
{

void mountFilesystems()
{
	// OPFS backend must be created off the browser main thread - main() runs in a worker (PROXY_TO_PTHREAD)
	backend_t opfs = wasmfs_create_opfs_backend();
	if (wasmfs_create_directory("/opfs", 0777, opfs) != 0)
		throw std::runtime_error("Failed to mount browser storage (OPFS)");

	for (const char * path : { "/opfs/h3", "/opfs/user", "/tmp" })
		boost::filesystem::create_directories(path);
}

void notify(const std::string & event, const std::string & detail)
{
	// ownership of both strings passes to the browser main thread
	vcmi_web_notify(strdup(event.c_str()), detail.empty() ? nullptr : strdup(detail.c_str()));
}

static std::function<void()> frameCallback;

static void runFrame()
{
	try
	{
		frameCallback();
	}
	catch (const GameShutdownException &)
	{
		emscripten_cancel_main_loop();
		notify("exit");
	}
	catch (const std::exception & e)
	{
		emscripten_cancel_main_loop();
		notify("fatal", e.what());
	}
}

void startMainLoop(std::function<void()> frame)
{
	frameCallback = std::move(frame);
	notify("running");
	// fps = 0: driven by requestAnimationFrame. Does not simulate an infinite loop -
	// the caller returns normally and the worker keeps running from its event loop.
	emscripten_set_main_loop(runFrame, 0, false);
}

}

#endif
