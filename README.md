# Long Thread Organizer 🏷️

[![Watch the video](https://img.youtube.com/vi/QqYZYQUL658/0.jpg)](https://youtu.be/QqYZYQUL658)

When you conversation with AI, the thread becomes long and you loose track to each message, this extension solve two issues:
1. You can organize messages by tag and make subgroup by filtering by tag. It is helpful when you have many sub-topic inside a thread
2. You can jump directly to each message. 

This is similar to extension Scroll at https://github.com/asker-kurtelli/scroll but differ in two points:
1. It allow delete messages and group messages by custom tag
2. It also work for NotebookLM


## 🚀 Installation (Developer Mode)

Since this extension is not yet on the Chrome Web Store, you can install it manually:

1. Clone or download this repository to your computer.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right corner).
4. Click **Load unpacked** and select the folder containing this extension.
5. Pin the extension to your toolbar for easy access.

## 💡 Usage

1. Open a conversation in one of the supported AI platforms.
2. Click the extension icon to open the **Side Panel**.
3. The panel will automatically detect the platform, scan the conversation, and list all your prompts.
4. **Add a Tag:** Click the `+` button next to any message in the sidebar to type a custom tag.
5. **Filter:** Click on a tag at the top of the side panel to toggle visibility. Only messages (and their AI responses) with that tag will remain visible in the main chat window.
6. **Navigate:** Click the text of any message in the sidebar to scroll directly to it.

## 💡 Future
In future, I would like to add note taking to each answer and export the answers edited by these note, so that we can output meaningful and organized document from the answers.

## 🔒 Privacy

All tags and metadata are stored entirely locally on your device using `chrome.storage.local`. No data is sent to any external servers.
