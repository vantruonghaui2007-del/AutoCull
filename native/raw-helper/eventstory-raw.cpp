// eventstory-raw: read-only RAW decoder for EventStory Cull, built on LibRaw 0.22.3 (CDDL-1.0).
//
//   eventstory-raw --version
//   eventstory-raw <input> [--max-mp 60] [--mem-mib 1536]
//
// Opens the RAW file read-only, refuses images above --max-mp megapixels, caps its own memory,
// decodes with the camera white balance, no auto-brightening, no sharpening and no presets, and
// writes to stdout: one JSON header line, then width*height*3 bytes of 8-bit sRGB, already
// rotated by the RAW orientation (the caller must not rotate again). Errors: one JSON line and a
// non-zero exit code. It never writes to the input file or anywhere else on disk.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <string>

#include "libraw/libraw.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <sys/resource.h>
#endif

enum Exit { OK = 0, USAGE = 2, UNSUPPORTED = 3, TOO_LARGE = 4, CORRUPT = 5, PROCESS = 6, WRITE = 7, MEMORY = 8 };

static std::string jsonEscape(const char *s) {
  std::string out;
  for (const char *p = s ? s : ""; *p; ++p) {
    unsigned char c = static_cast<unsigned char>(*p);
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += static_cast<char>(c);
  }
  return out;
}

static int fail(int code, const char *name, const char *message) {
  std::fprintf(stdout, "{\"ok\":false,\"code\":\"%s\",\"message\":\"%s\"}\n", name, jsonEscape(message).c_str());
  std::fflush(stdout);
  return code;
}

static void limitMemory(unsigned long long mib) {
#ifdef _WIN32
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    info.ProcessMemoryLimit = static_cast<SIZE_T>(mib * 1024ULL * 1024ULL);
    if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof info)) AssignProcessToJobObject(job, GetCurrentProcess());
  }
#else
  // RLIMIT_AS bounds address space (enforced on Linux; macOS does not enforce it — documented limitation).
  struct rlimit rl;
  rl.rlim_cur = rl.rlim_max = static_cast<rlim_t>(mib * 1024ULL * 1024ULL);
  setrlimit(RLIMIT_AS, &rl);
#endif
}

static int classify(int ret) {
  if (ret == LIBRAW_UNSUFFICIENT_MEMORY) return MEMORY;
  if (ret == LIBRAW_FILE_UNSUPPORTED || ret == LIBRAW_IO_ERROR) return UNSUPPORTED;
  return CORRUPT;
}
static const char *codeName(int exitCode) {
  switch (exitCode) {
    case UNSUPPORTED: return "RAW_UNSUPPORTED";
    case TOO_LARGE: return "RAW_TOO_LARGE";
    case MEMORY: return "RAW_MEMORY_LIMIT";
    case PROCESS: return "RAW_PROCESS_FAILED";
    case WRITE: return "RAW_WRITE_FAILED";
    default: return "RAW_CORRUPT";
  }
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
  _setmode(_fileno(stdout), _O_BINARY);
#define ARG_EQ(i, s) (wcscmp(argv[i], L##s) == 0)
#define ARG_NUM(i) _wtof(argv[i])
#else
int main(int argc, char **argv) {
#define ARG_EQ(i, s) (std::strcmp(argv[i], s) == 0)
#define ARG_NUM(i) std::atof(argv[i])
#endif
  if (argc >= 2 && ARG_EQ(1, "--version")) {
    std::printf("{\"libraw\":\"%s\",\"helper\":\"1\"}\n", LibRaw::version());
    return OK;
  }
  if (argc < 2) return fail(USAGE, "USAGE", "eventstory-raw <input> [--max-mp N] [--mem-mib N]");
  double maxMp = 60, memMib = 1536;
  for (int i = 2; i + 1 < argc; i += 2) {
    if (ARG_EQ(i, "--max-mp")) maxMp = ARG_NUM(i + 1);
    else if (ARG_EQ(i, "--mem-mib")) memMib = ARG_NUM(i + 1);
  }
  limitMemory(static_cast<unsigned long long>(memMib));

  try {
    // LibRaw is several hundred KB: keep it off the 1 MB default stack.
    std::unique_ptr<LibRaw> holder(new LibRaw());
    LibRaw &raw = *holder;
    raw.imgdata.params.use_camera_wb = 1;
    raw.imgdata.params.use_auto_wb = 0;
    raw.imgdata.params.no_auto_bright = 1;
    raw.imgdata.params.output_bps = 8;
    raw.imgdata.params.output_color = 1;  // sRGB
    raw.imgdata.params.half_size = 0;

    int ret = raw.open_file(argv[1]);
    if (ret != LIBRAW_SUCCESS) { int c = classify(ret); return fail(c, codeName(c), libraw_strerror(ret)); }
    const double mp = double(raw.imgdata.sizes.width) * double(raw.imgdata.sizes.height) / 1e6;
    if (mp <= 0) return fail(UNSUPPORTED, "RAW_UNSUPPORTED", "no image data");
    if (mp > maxMp) return fail(TOO_LARGE, "RAW_TOO_LARGE", "image exceeds the megapixel limit");
    if ((ret = raw.unpack()) != LIBRAW_SUCCESS) { int c = classify(ret); return fail(c, codeName(c), libraw_strerror(ret)); }
    if ((ret = raw.dcraw_process()) != LIBRAW_SUCCESS) { int c = ret == LIBRAW_UNSUFFICIENT_MEMORY ? MEMORY : PROCESS; return fail(c, codeName(c), libraw_strerror(ret)); }
    libraw_processed_image_t *img = raw.dcraw_make_mem_image(&ret);
    if (!img || ret != LIBRAW_SUCCESS) { int c = ret == LIBRAW_UNSUFFICIENT_MEMORY ? MEMORY : PROCESS; return fail(c, codeName(c), libraw_strerror(ret)); }
    if (img->type != LIBRAW_IMAGE_BITMAP || img->colors != 3 || img->bits != 8) {
      LibRaw::dcraw_clear_mem(img);
      return fail(PROCESS, "RAW_PROCESS_FAILED", "unexpected output layout");
    }
    std::fprintf(stdout, "{\"ok\":true,\"width\":%u,\"height\":%u,\"bytes\":%u,\"make\":\"%s\",\"model\":\"%s\",\"libraw\":\"%s\"}\n", img->width, img->height,
                 img->data_size, jsonEscape(raw.imgdata.idata.make).c_str(), jsonEscape(raw.imgdata.idata.model).c_str(), LibRaw::version());
    const size_t written = std::fwrite(img->data, 1, img->data_size, stdout);
    std::fflush(stdout);
    const unsigned int expected = img->data_size;  // read before the image is freed
    LibRaw::dcraw_clear_mem(img);
    if (written != expected) return WRITE;
    return OK;
  } catch (const std::bad_alloc &) {
    return fail(MEMORY, "RAW_MEMORY_LIMIT", "memory limit reached");
  } catch (...) {
    return fail(CORRUPT, "RAW_CORRUPT", "decoder error");
  }
}
