# Dedicated context only: public packed packages and the explicitly named helpers.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725 AS compatibility
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev python3
COPY wine-procmem.c /build/wine-procmem.c
RUN cc -shared -fPIC -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now \
      -o /build/wine-procmem.so /build/wine-procmem.c -ldl -pthread \
    && python3 -c 'import hashlib,json,subprocess,pathlib; p=pathlib.Path("/build"); h=lambda n:hashlib.sha256((p/n).read_bytes()).hexdigest(); (p/"compatibility.json").write_text(json.dumps({"schemaVersion":1,"sourceSha256":h("wine-procmem.c"),"sha256":h("wine-procmem.so"),"compiler":subprocess.check_output(["cc","--version"],text=True).splitlines()[0]}))'

FROM --platform=linux/amd64 ubuntu:26.04@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725

ARG SOURCE_REVISION=local
LABEL org.opencontainers.image.title="Q-SYS Designer vendor-free Linux test runtime" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

# Depends from wine-staging 11.20~resolute-1 amd64 (recipe SHA256
# 0429ca26cf940f78ae17bf5279779dffdc675878f07180c570bf9a34cdeb24c1).
# Also include its graphics/font/TLS recommendations needed by Designer.
# No Wine package is installed here: the recipe supplies its verified runtime.
# Keep signed apt indexes for the unprivileged recipe's `apt-get download`.
# They are not snapshot-pinned: rebuild if Ubuntu retires indexed packages;
# never work around a stale index with unauthenticated downloads.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 procps util-linux \
      xvfb xauth openbox x11-utils x11-xserver-utils xdotool xclip \
      scrot imagemagick python3-pil fontconfig fonts-dejavu-core \
      libasound2t64 libavcodec62 libavformat62 libavutil60 libc6 libgcc-s1 \
      libglib2.0-0t64 libgphoto2-6t64 libgphoto2-port12t64 libgssapi-krb5-2 \
      libgstreamer-plugins-base1.0-0 libgstreamer1.0-0 libkrb5-3 libpcap0.8t64 \
      libpcsclite1 libpulse0 libsane1 libudev1 libusb-1.0-0 \
      libwayland-client0 libwayland-egl1 libx11-6 libxext6 libxkbcommon0 \
      libxkbregistry0 ocl-icd-libopencl1 libasound2-plugins libncurses6 \
      libcairo2 libcups2t64 libdbus-1-3 libfontconfig1 libfreetype6 \
      libglu1-mesa libgl1-mesa-dri libglx-mesa0 libgnutls30t64 libgtk-3-0t64 \
      libodbc2 libsdl2-2.0-0 libv4l-0t64 libva-drm2 libva-x11-2 libva2 \
      libxcomposite1 libxcursor1 libxfixes3 libxi6 libxinerama1 libxrandr2 \
      libxrender1 libxxf86vm1 \
      7zip msitools libmsi-1.0-0 libgcab-1.0-0 icoutils libarchive-tools \
    && mkdir -p /opt/qsys-test \
    && dpkg-query -W -f='${Package}\t${Version}\n' > /opt/qsys-test/dpkg-inventory.tsv \
    && rm -rf /var/cache/apt/archives/*.deb

# Official Node release; checksum from that release's SHASUMS256.txt.
RUN curl --fail --show-error --location --retry 3 \
      https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && echo '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  /tmp/node.tar.xz' | sha256sum -c - \
    && bsdtar --no-same-owner -xf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz

COPY qsys-linux.tgz qsys-qrc.tgz /tmp/packages/
RUN sha256sum /tmp/packages/*.tgz > /opt/qsys-test/package-sha256.txt \
    && npm install --global --offline --ignore-scripts --no-audit --no-fund /tmp/packages/qsys-linux.tgz \
    && npm install --prefix /opt/qsys-test --offline --ignore-scripts --no-audit --no-fund /tmp/packages/qsys-qrc.tgz \
    && ln -s /usr/local/lib/node_modules/qsys-linux/lib/support/fonts /usr/local/share/fonts/qsys-selawik \
    && fc-cache -f \
    && rm -rf /tmp/packages /root/.npm

COPY smoke.py qrc-smoke.mjs execution.py qemu-pin.json /opt/qsys-test/
COPY --from=compatibility /build/wine-procmem.so /build/compatibility.json /opt/qsys-test/
COPY qemu-shim.py /opt/qsys-test/shims/qsys-linux
COPY entrypoint.sh /usr/local/bin/qsys-docker-entrypoint
COPY dpkg-deb.py /usr/local/bin/dpkg-deb
# Ubuntu's base may already own UID/GID 1000; rename that account instead of
# dynamically selecting a UID (volume copy-up must always produce 1000:1000).
RUN set -eux; \
    if ! getent group 1000; then groupadd --gid 1000 qsys; fi; \
    if getent passwd 1000; then usermod --login qsys --home /home/qsys --move-home "$(getent passwd 1000 | cut -d: -f1)"; else useradd --uid 1000 --gid 1000 --create-home qsys; fi; \
    if ! getent group qsys; then groupmod --new-name qsys "$(getent group 1000 | cut -d: -f1)"; fi; \
    usermod --gid 1000 qsys; \
    mkdir -p /input /work/tmp /cache /artifacts /home/qsys; \
    chown -R 1000:1000 /input /work /cache /artifacts /home/qsys; \
    cp /opt/qsys-test/shims/qsys-linux /opt/qsys-test/shims/dpkg-deb; \
    chmod 0755 /opt/qsys-test/shims/qsys-linux /opt/qsys-test/shims/dpkg-deb; \
    chmod 0755 /usr/local/bin/qsys-docker-entrypoint /usr/local/bin/dpkg-deb; \
    chown -R root:root /usr/local /opt/qsys-test

ENV HOME=/home/qsys USER=qsys TMPDIR=/work/tmp DISPLAY=:99 \
    XDG_DATA_HOME=/work LIBGL_ALWAYS_SOFTWARE=1 \
    GALLIUM_DRIVER=llvmpipe LANG=C.UTF-8
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/qsys-docker-entrypoint"]
CMD ["check"]
