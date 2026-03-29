FROM debian:bookworm-slim

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      libegl1-mesa \
      libgles2-mesa \
      libgl1-mesa-dri \
      xvfb \
      x11vnc \
      novnc \
      python3-websockify && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd -r chrome && useradd -r -g chrome -G audio,video chrome && \
    mkdir -p /home/chrome/data && chown -R chrome:chrome /home/chrome

COPY --chmod=755 start.sh /start.sh

USER chrome

EXPOSE 9222 6080

ENTRYPOINT ["/start.sh"]
