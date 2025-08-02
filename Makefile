NORMAL_FONT_DOWNLOAD_URL	= https://github.com/yuru7/PlemolJP/releases/download/v2.0.3/PlemolJP_NF_v2.0.3.zip
NORMAL_FONT_DOWNLOAD_FILE	= PlemolJP_NF_v2.0.3
NORMAL_REGULAR_FONT_FILE_NAME	= PlemolJP_NF_v2.0.3/PlemolJPConsole_NF/PlemolJPConsoleNF-Regular.ttf
NORMAL_BOLD_FONT_FILE_NAME	= PlemolJP_NF_v2.0.3/PlemolJPConsole_NF/PlemolJPConsoleNF-Bold.ttf
ALT_FONT_DOWNLOAD_URL		= https://github.com/yuru7/moralerspace/releases/download/v1.1.0/MoralerspaceHWNF_v1.1.0.zip
ALT_FONT_DOWNLOAD_FILE		= MoralerspaceHWNF_v1.1.0
ALT_REGULAR_FONT_FILE_NAME	= MoralerspaceHWNF_v1.1.0/MoralerspaceRadonHWNF-Regular.ttf
ALT_BOLD_FONT_FILE_NAME		= MoralerspaceHWNF_v1.1.0/MoralerspaceRadonHWNF-Bold.ttf
ICON_FONT_DOWNLOAD_URL		= https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/NerdFontsSymbolsOnly.zip
ICON_FONT_DOWNLOAD_FILE		= NerdFontsSymbolsOnly_v.3.4.0
ICON_REGULAR_FONT_FILE_NAME	= SymbolsNerdFontMono-Regular.ttf
ICON_BOLD_FONT_FILE_NAME	= SymbolsNerdFontMono-Regular.ttf
GIT_FONT_DOWNLOAD_URL		= https://github.com/rbong/flog-symbols/archive/refs/tags/v1.1.0.zip
GIT_FONT_DOWNLOAD_FILE		= flog-symbols-1.1.0
GIT_REGULAR_FONT_FILE_NAME	= flog-symbols-1.1.0/FlogSymbols.ttf
GIT_BOLD_FONT_FILE_NAME		= flog-symbols-1.1.0/FlogSymbols.ttf

DOWNLOAD_CMD			= curl -L
UNZIP_CMD			= unzip -o
RELEASE_CMD			= npm run release -- -p never
TARGET_FILE_NAME		=/mnt/home/Downloads/Envim.bk

build: install renderer/fonts/NORMAL/$(NORMAL_FONT_DOWNLOAD_FILE).zip renderer/fonts/ALT/$(ALT_FONT_DOWNLOAD_FILE).zip renderer/fonts/ICON/$(ICON_FONT_DOWNLOAD_FILE).zip renderer/fonts/GIT/$(GIT_FONT_DOWNLOAD_FILE).zip
	DEVELOPMENT= npm run build

install:
	npm install

renderer/fonts/%.zip:
	$(DOWNLOAD_CMD) $($(*D)_FONT_DOWNLOAD_URL) -o $($(*D)_FONT_DOWNLOAD_FILE).zip
	$(UNZIP_CMD) -d $(*F) $(*F)
	cp $(*F)/$($(*D)_REGULAR_FONT_FILE_NAME) renderer/fonts/$(*D)-Regular.font
	cp $(*F)/$($(*D)_BOLD_FONT_FILE_NAME) renderer/fonts/$(*D)-Bold.font
	rm -rf $(@D)
	mkdir -p $(@D)
	touch $@
	rm -rf $(*F) $(@F)

linux: build
	$(RELEASE_CMD) --linux appImage
ifdef TARGET_FILE_NAME
	rm -rf $(TARGET_FILE_NAME)
	mv release/Envim-1.0.0.AppImage $(TARGET_FILE_NAME)
endif

mac: build
	$(RELEASE_CMD) --mac zip
ifdef TARGET_FILE_NAME
	rm -rf $(TARGET_FILE_NAME)
	mv release/mac/Envim.app $(TARGET_FILE_NAME)
endif

windows: build
	$(RELEASE_CMD) --win zip
ifdef TARGET_FILE_NAME
	rm -rf $(TARGET_FILE_NAME)
	mv release/win-unpacked $(TARGET_FILE_NAME)
endif
