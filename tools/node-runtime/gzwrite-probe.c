/* Synthetic regression for the exact bundled zlib gz_write error path.
 * No libz is linked: gz* resolve against the running Node executable exports.
 * /dev/full reliably fails writes without creating a file or changing any data.
 * The vulnerable baseline is inspected BEFORE attempting an unsafe follow-up.
 */
#define _LARGEFILE64_SOURCE 1
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <node_api.h>
#include "gzguts.h"

static void boolean(napi_env env, napi_value object, const char *key, int value) {
    napi_value result;
    napi_get_boolean(env, value != 0, &result);
    napi_set_named_property(env, object, key, result);
}
static void number(napi_env env, napi_value object, const char *key, int value) {
    napi_value result;
    napi_create_int32(env, value, &result);
    napi_set_named_property(env, object, key, result);
}
static napi_value probe(napi_env env, napi_callback_info info) {
    (void)info;
    const unsigned length = 4096;
    unsigned char *input = malloc(length);
    if (!input) { napi_throw_error(env, NULL, "Unable to allocate synthetic input"); return NULL; }
    memset(input, 'A', length);
    gzFile file = gzopen("/dev/full", "wbT");
    if (!file || gzbuffer(file, 128) != 0) {
        if (file) gzclose(file);
        free(input); napi_throw_error(env, NULL, "Unable to initialize native gz probe"); return NULL;
    }
    errno = 0;
    int written = gzwrite(file, input, length);
    int write_errno = errno;
    gz_statep state = (gz_statep)file;
    int reset = state->strm.avail_in == 0 && state->strm.next_in == state->in;
    int stale = state->strm.next_in == input && state->strm.avail_in == length;
    int followup = -1;
    if (reset) {
        gzclearerr(file);
        followup = gzprintf(file, "%s", "synthetic follow-up");
    }
    int closed = gzclose(file);
    free(input);
    napi_value result;
    napi_create_object(env, &result);
    boolean(env, result, "writeFailed", written == 0 && write_errno == ENOSPC);
    boolean(env, result, "inputReset", reset);
    boolean(env, result, "externalBufferRetained", stale);
    number(env, result, "followupBytes", followup);
    number(env, result, "closeStatus", closed);
    return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "probe", NAPI_AUTO_LENGTH, probe, NULL, &function);
    napi_set_named_property(env, exports, "probe", function);
    return exports;
}
NAPI_MODULE(native_gzwrite, initialize)
