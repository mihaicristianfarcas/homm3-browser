/*
 * CFileInputStream.cpp, part of VCMI engine
 *
 * Authors: listed in file AUTHORS in main folder
 *
 * License: GNU General Public License v2.0 or later
 * Full text of license available in license.txt file, in main folder
 *
 */
#include "StdInc.h"
#include "CFileInputStream.h"

#include "../ExceptionsCommon.h"

#ifdef VCMI_EMSCRIPTEN
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

VCMI_LIB_NAMESPACE_BEGIN

#ifdef VCMI_EMSCRIPTEN

CFileInputStream::CFileInputStream(const boost::filesystem::path & file, si64 start, si64 size)
	: dataStart{start}
	, dataSize{size}
	, fileDescriptor{open(file.c_str(), O_RDONLY)}
{
	if (fileDescriptor < 0)
		throw DataLoadingException("Failed to open file '" + file.string() + "'. Reason: " + strerror(errno) );

	if (dataSize == 0)
	{
		struct stat info;
		if (fstat(fileDescriptor, &info) != 0)
			throw DataLoadingException("Failed to read size of file '" + file.string() + "'. Reason: " + strerror(errno) );
		dataSize = std::max<si64>(0, info.st_size - dataStart);
	}
}

CFileInputStream::~CFileInputStream()
{
	close(fileDescriptor);
}

si64 CFileInputStream::read(ui8 * data, si64 size)
{
	si64 toRead = std::max<si64>(0, std::min(dataSize - position, size));
	si64 done = 0;

	while (done < toRead)
	{
		si64 offset = dataStart + position;
		si64 chunk;

		if (offset >= bufferOffset && offset < bufferOffset + bufferSize)
		{
			chunk = std::min(toRead - done, bufferOffset + bufferSize - offset);
			std::memcpy(data + done, buffer.data() + (offset - bufferOffset), chunk);
		}
		else if (toRead - done >= bufferCapacity)
		{
			// large reads bypass the buffer
			chunk = pread(fileDescriptor, data + done, toRead - done, offset);
			if (chunk <= 0)
				break;
		}
		else
		{
			buffer.resize(bufferCapacity);
			bufferOffset = offset;
			bufferSize = std::max<si64>(0, pread(fileDescriptor, buffer.data(), bufferCapacity, offset));
			if (bufferSize == 0)
				break;
			continue;
		}

		done += chunk;
		position += chunk;
	}
	return done;
}

si64 CFileInputStream::seek(si64 newPosition)
{
	position = std::clamp<si64>(newPosition, 0, dataSize);
	return position;
}

si64 CFileInputStream::tell()
{
	return position;
}

si64 CFileInputStream::skip(si64 delta)
{
	si64 origin = position;
	position = std::clamp<si64>(position + delta, 0, dataSize);
	return position - origin;
}

si64 CFileInputStream::getSize()
{
	return dataSize;
}

#else

CFileInputStream::CFileInputStream(const boost::filesystem::path & file, si64 start, si64 size)
  : dataStart{start},
	dataSize{size},
	fileStream{file.c_str(), std::ios::in | std::ios::binary}
{
	if (fileStream.fail())
		throw DataLoadingException("Failed to open file '" + file.string() + "'. Reason: " + strerror(errno) );

	if (dataSize == 0)
	{
		fileStream.seekg(0, std::ios::end);
		dataSize = tell();
	}

	fileStream.seekg(dataStart, std::ios::beg);
}


si64 CFileInputStream::read(ui8 * data, si64 size)
{
	si64 origin = tell();
	si64 toRead = std::min(dataSize - origin, size);
	fileStream.read(reinterpret_cast<char *>(data), toRead);
	return fileStream.gcount();
}

si64 CFileInputStream::seek(si64 position)
{
	fileStream.seekg(dataStart + std::min(position, dataSize));
	return tell();
}

si64 CFileInputStream::tell()
{
	return static_cast<si64>(fileStream.tellg()) - dataStart;
}

si64 CFileInputStream::skip(si64 delta)
{
	si64 origin = tell();
	//ensure that we're not seeking past the end of real data
	si64 toSeek = std::min(dataSize - origin, delta);
	fileStream.seekg(toSeek, std::ios::cur);

	return tell() - origin;
}

si64 CFileInputStream::getSize()
{
	return dataSize;
}

#endif

VCMI_LIB_NAMESPACE_END
