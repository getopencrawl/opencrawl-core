/* Test-only syscall fixture. Node/libuv reaps children, so it cannot serve as the
 * deliberately non-reaping PID 1 required to detect orphaned capture workers.
 * All product assertions live in process-ownership.mts. This helper reaps ONLY
 * explicitly requested PIDs; it never installs a SIGCHLD handler or waitpid(-1).
 */
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <fcntl.h>
#include <dirent.h>
static void fail(const char *what) { perror(what); exit(1); }
static void require(int condition, const char *what) { if (!condition) { fprintf(stderr, "%s\n", what); exit(1); } }
static int reap(pid_t pid) { int status; while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) fail("waitpid"); return WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status); }
static void worker(const char *dist, const char *config, int channel) {
  close(channel);
  require(setenv("OPENCRAWL_CONFIG_HOME", config, 1) == 0, "config environment");
  require(setenv("OPENCRAWL_NO_UPDATE", "1", 1) == 0, "update environment");
  require(setenv("OPENCRAWL_SESSIONS_TOKEN", "synthetic-process-ownership-fixture", 1) == 0, "fixture credential");
  int null = open("/dev/null", O_RDWR); if (null < 0) fail("open null");
  for (int fd = 0; fd <= 2; fd++) if (dup2(null, fd) < 0) fail("dup null");
  if (null > 2) close(null);
  char binary[4096]; require(snprintf(binary, sizeof binary, "%s/linux-x64/bin/opencrawl", dist) < (int) sizeof binary, "binary path too long");
  execl(binary, binary, "collect", "worker", (char *) NULL); _exit(127);
}
int main(int argc, char **argv) {
  require(argc == 4 && getpid() == 1, "Run init NODE SCRIPT DIST under unshare --fork --pid --mount-proc");
  int sockets[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets)) fail("socketpair");
  pid_t harness = fork(); if (harness < 0) fail("fork harness");
  if (!harness) { close(sockets[0]); if (dup2(sockets[1], 3) < 0) fail("dup channel"); if (sockets[1] != 3) close(sockets[1]); execl(argv[1], argv[1], argv[2], argv[3], (char *) NULL); _exit(127); }
  close(sockets[1]); FILE *input = fdopen(dup(sockets[0]), "r");
  FILE *channel = fdopen(sockets[0], "w");
  if (!input || !channel) fail("fdopen");
  setvbuf(channel, NULL, _IONBF, 0);
  char command[4096];
  while (fgets(command, sizeof command, input)) {
    command[strcspn(command, "\n")] = 0;
    if (!strcmp(command, "control")) {
      int pipefd[2]; if (pipe(pipefd)) fail("control pipe");
      pid_t intermediate = fork(); if (intermediate < 0) fail("fork control");
      if (!intermediate) { close(pipefd[0]); close(sockets[0]); pid_t orphan = fork(); if (orphan < 0) _exit(1);
        if (!orphan) { close(pipefd[1]); struct timespec delay = {0, 200000000}; nanosleep(&delay, NULL); _exit(0); }
        if (write(pipefd[1], &orphan, sizeof orphan) != sizeof orphan) _exit(1); _exit(0); }
      close(pipefd[1]); pid_t orphan; require(read(pipefd[0], &orphan, sizeof orphan) == sizeof orphan, "control PID"); close(pipefd[0]); require(reap(intermediate) == 0, "control exit"); fprintf(channel, "%d\n", orphan);
    } else if (!strcmp(command, "parent-loss") || !strcmp(command, "pid1-worker")) {
      char config[4096]; require(fgets(config, sizeof config, input) != NULL, "config missing"); config[strcspn(config, "\n")] = 0;
      if (!strcmp(command, "pid1-worker")) { pid_t child = fork(); if (child < 0) fail("fork worker"); if (!child) worker(argv[3], config, sockets[0]); fprintf(channel, "%d\n", child); }
      else { int pipefd[2]; if (pipe(pipefd)) fail("owner pipe"); pid_t owner = fork(); if (owner < 0) fail("fork owner");
        if (!owner) { close(pipefd[0]); pid_t child = fork(); if (child < 0) _exit(1); if (!child) { close(pipefd[1]); worker(argv[3], config, sockets[0]); } if (write(pipefd[1], &child, sizeof child) != sizeof child) _exit(1); close(pipefd[1]); close(sockets[0]); for (;;) pause(); }
        close(pipefd[1]); pid_t child; require(read(pipefd[0], &child, sizeof child) == sizeof child, "worker PID"); close(pipefd[0]); fprintf(channel, "%d %d\n", owner, child);
      }
    } else if (!strncmp(command, "reap ", 5)) {
      char *end; long pid = strtol(command + 5, &end, 10); require(*end == 0 && pid > 1 && pid != harness, "invalid explicit reap PID"); fprintf(channel, "%d\n", reap((pid_t) pid));
    } else if (!strcmp(command, "audit")) {
      DIR *proc = opendir("/proc"); if (!proc) fail("opendir proc"); struct dirent *entry; int clean = 1;
      while ((entry = readdir(proc))) { char *end; long pid = strtol(entry->d_name, &end, 10); if (!*end && pid > 0 && pid != 1 && pid != harness) clean = 0; } closedir(proc); fprintf(channel, "%d\n", clean);
    } else { require(0, "unknown init command"); }
  }
  fclose(input); fclose(channel); return reap(harness);
}
