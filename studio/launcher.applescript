on run
    try
        do shell script "cd '/Users/john/Documents/一句' && '/Users/john/.nvm/versions/node/v24.14.1/bin/node' --env-file-if-exists=.env studio/launcher.mjs"
    on error messageText
        display dialog messageText with title "一句 · 语言练习" buttons {"好"} default button "好" with icon caution
    end try
end run
