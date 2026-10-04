import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "rickom1.agent-status"

  readonly property string script: (Quickshell.env("HOME") || "") + "/.config/omarchy/plugins/rickom1.agent-status/status.py"
  property var snapshot: ({ agents: {}, sounds: {} })
  property bool popupOpen: false
  readonly property var order: ["codex", "claude", "hermes", "herder"]
  readonly property var soundNames: ["Off", "Complete", "Bell", "Message", "Warning"]
  readonly property var visibleAgents: {
    var result = []
    for (var i = 0; i < order.length; i++) {
      var agent = snapshot.agents ? snapshot.agents[order[i]] : null
      if (agent && agent.visible) result.push(agent)
    }
    return result
  }

  function colorFor(state) {
    if (state === "working" || state === "done") return "#4ecb71"
    if (state === "attention") return "#f5c84c"
    if (state === "error" || state === "stopped") return "#f16d6d"
    return "#8b929d"
  }

  function iconFor(agent) {
    if (agent === "codex") return "file:///usr/share/icons/hicolor/256x256/apps/chatgpt.png"
    if (agent === "hermes") return "file:///usr/share/icons/hicolor/256x256/apps/hermes-desktop.png"
    if (agent === "claude") return "file://" + (Quickshell.env("HOME") || "") + "/.config/omarchy/plugins/rickom1.agent-status/claude-rgba.png"
    return ""
  }

  function refresh() {
    if (!pollProcess.running) pollProcess.running = true
  }

  function changeSound(state, name) {
    setSoundProcess.command = ["python3", root.script, "sound", state, name]
    setSoundProcess.running = true
    var sounds = Object.assign({}, snapshot.sounds || {})
    sounds[state] = name
    snapshot = Object.assign({}, snapshot, { sounds: sounds })
  }

  Timer {
    interval: 3000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: pollProcess
    command: ["python3", root.script, "poll"]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          root.snapshot = JSON.parse(text)
        } catch (e) {
          console.warn("agent-status: invalid collector output", e)
        }
      }
    }
  }

  Process {
    id: setSoundProcess
    running: false
  }

  visible: visibleAgents.length > 0
  implicitWidth: visible ? badges.implicitWidth + Style.space(12) : 0
  implicitHeight: barSize

  Row {
    id: badges
    anchors.centerIn: parent
    spacing: Style.space(8)

    Repeater {
      model: root.visibleAgents

      Row {
        required property var modelData
        spacing: Style.space(3)
        anchors.verticalCenter: parent ? parent.verticalCenter : undefined

        Image {
          id: agentIcon
          width: Style.space(17)
          height: Style.space(17)
          anchors.verticalCenter: parent.verticalCenter
          source: root.iconFor(modelData.agent)
          fillMode: Image.PreserveAspectFit
          visible: source !== "" && status === Image.Ready
        }
        Text {
          visible: !agentIcon.visible
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.name ? modelData.name.charAt(0) : "?"
          color: root.bar.barForeground
          font.family: root.bar.fontFamily
          font.bold: true
          font.pixelSize: Style.font.bodySmall
        }
        Text {
          visible: !!modelData.workspace
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.workspace ? "#" + modelData.workspace : ""
          color: root.bar.barForeground
          font.family: root.bar.fontFamily
          font.bold: true
          font.pixelSize: Style.font.caption
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.symbol || "○"
          color: root.colorFor(modelData.state)
          font.family: root.bar.fontFamily
          font.bold: true
          font.pixelSize: Style.font.body
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.page || modelData.name || ""
          color: root.bar.barForeground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          width: Math.min(90, implicitWidth)
        }
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    cursorShape: Qt.PointingHandCursor
    onClicked: root.popupOpen = !root.popupOpen
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(340))
    contentHeight: popup.fittedContentHeight(panel.implicitHeight)

    Column {
      id: panel
      anchors.fill: parent
      spacing: Style.space(10)

      Text {
        text: "LIVE AGENTS"
        color: root.bar.foreground
        font.family: root.bar.fontFamily
        font.bold: true
        font.pixelSize: Style.font.caption
      }

      Repeater {
        model: root.visibleAgents
        Row {
          required property var modelData
          width: panel.width
          spacing: Style.space(8)
          Text {
            text: (modelData.symbol || "○") + "  " + (modelData.name || "") + (modelData.workspace ? "  #" + modelData.workspace : "")
            color: root.colorFor(modelData.state)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
            width: Style.space(105)
          }
          Text {
            text: modelData.page || modelData.state || ""
            textFormat: Text.PlainText
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            width: panel.width - Style.space(115)
          }
        }
      }

      PanelSeparator { foreground: root.bar.foreground }

      Text {
        text: "SOUNDS"
        color: root.bar.foreground
        font.family: root.bar.fontFamily
        font.bold: true
        font.pixelSize: Style.font.caption
      }

      Repeater {
        model: [
          { state: "working", label: "Working" },
          { state: "done", label: "Done" },
          { state: "attention", label: "Needs you" },
          { state: "stopped", label: "Stopped" },
          { state: "error", label: "Problem" }
        ]
        Row {
          required property var modelData
          width: panel.width
          spacing: Style.space(8)
          Text {
            text: modelData.label
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(95)
          }
          Dropdown {
            width: panel.width - Style.space(105)
            options: root.soundNames
            value: (root.snapshot.sounds || {})[modelData.state] || "Off"
            foreground: root.bar.foreground
            onChanged: function(name) { root.changeSound(modelData.state, name) }
          }
        }
      }
    }
  }
}
