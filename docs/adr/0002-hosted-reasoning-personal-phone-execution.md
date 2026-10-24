# Allow hosted reasoning while operating the user's phone

The hackathon assistant may use hosted voice and navigation models, while phone
actions execute on the user's actual Android device. Ronit confirmed that fully
local inference is not required. This lets us expand phone actions without first
making model inference work on the phone.

This decision does not select Mobilerun Cloud or a particular UI executor.

UI tasks visibly operate apps on the phone's screen, with user interruption and
takeover available. Supported direct actions can avoid screen navigation. The
hackathon build does not promise simultaneous user browsing during UI execution.
