NORMAL_FONT_DOWNLOAD_URL	=
NORMAL_FONT_DOWNLOAD_FILE	=
NORMAL_REGULAR_FONT_FILE_NAME	=
NORMAL_BOLD_FONT_FILE_NAME	=
ALT_FONT_DOWNLOAD_URL		=
ALT_FONT_DOWNLOAD_FILE		=
ALT_REGULAR_FONT_FILE_NAME	=
ALT_BOLD_FONT_FILE_NAME		=
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
RELEASE_CMD			= npm run release --
TARGET_FILE_NAME		=

build: install renderer/fonts/NORMAL/$(NORMAL_FONT_DOWNLOAD_FILE).zip renderer/fonts/ALT/$(ALT_FONT_DOWNLOAD_FILE).zip renderer/fonts/ICON/$(ICON_FONT_DOWNLOAD_FILE).zip renderer/fonts/GIT/$(GIT_FONT_DOWNLOAD_FILE).zip
	npm run build

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
