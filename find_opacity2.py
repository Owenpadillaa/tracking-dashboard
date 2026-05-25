import re
for fname in ['css_part1.css','css_part2.css','css_part3.css']:
    with open(fname,'r',encoding='utf-8',newline='') as f:
        content = f.read()
    # Find all lines with opacity
    for i,line in enumerate(content.split('\n'),1):
        stripped = line.strip()
        if stripped.startswith('*') or not stripped:
            continue
        if 'opacity' in stripped and ':' in stripped:
            # Get surrounding context (2 lines before and after)
            lines = content.split('\n')
            context = []
            for j in range(max(0,i-3), min(len(lines),i+2)):
                marker = '>>>' if j == i-1 else '   '
                context.append(f'{marker} {j+1}: {lines[j]}')
            print(f'\n{fname}:{i}:')
            for c in context:
                print(c)