import os
for fname in ['css_part1.css','css_part2.css','css_part3.css']:
    try:
        with open(fname,'r',encoding='utf-8',newline='') as f:
            content = f.read()
        # Find .tab-page blocks with opacity
        import re
        # Match .tab-page followed by { ... opacity: 0 ... }
        pattern = r'\btab-page[^}]*?opacity:\u00a00'
        # Simpler: find lines mentioning tab-page and opacity
        for i,line in enumerate(content.split('\n'),1):
            if '.tab-page' in line and 'opacity' in line:
                print(f'{fname}:{i}: {line.strip()}')
    except Exception as e:
        print(f'{fname}: error {e}')