/*
 * WebPlatform.h, part of VCMI engine
 *
 * Authors: listed in file AUTHORS in main folder
 *
 * License: GNU General Public License v2.0 or later
 * Full text of license available in license.txt file, in main folder
 *
 */
#pragma once

#ifdef VCMI_EMSCRIPTEN

/// Integration with the browser for the Emscripten build of the client
namespace WebPlatform
{
	/// Mounts persistent browser storage. Must be called before VCMIDirs is used
	void mountFilesystems();

	/// Applies settings provided by the hosting page (e.g. lobby server address). Requires loaded settings
	void applyPageSettings();

	/// Notifies the hosting web page about client lifecycle (loading progress, errors, shutdown)
	void notify(const std::string & event, const std::string & detail = {});

	/// Starts running the game loop from the browser's frame callbacks and returns immediately.
	/// The frame callback is invoked once per frame until it throws GameShutdownException,
	/// then the shutdown callback releases the engine
	void startMainLoop(std::function<void()> frame, std::function<void()> shutdown);
}

#endif
